import { DeliveryStatusEnum, HashAlgorithmEnum, ItemTypeEnum, PrepareStatusEnum, } from "@app/common/database/entities";
import { Injectable, Logger } from "@nestjs/common";
import * as stream from 'stream';
import { HttpClientService } from "./http-client.service";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AxiosResponse } from "axios";
import { DeliveryStatusDto } from "@app/common/dto/delivery";
import { S3Service } from "@app/common/AWS/s3.service";
import { DeliveryItemEntity } from "@app/common/database-tng/entities";
import { ConfigService } from "@nestjs/config";
import { DeliveryError } from "@app/common/dto/delivery/dto/delivery-error";
import { ErrorCode } from "@app/common/dto/error";
import { HashDto } from "@app/common/dto/delivery/dto/delivery-item.dto";
import { Hash, createHash } from 'crypto';

const UPDATE_INTERVAL_MLS = 5000;

@Injectable()
export class DownloadService {
  private readonly logger = new Logger(DownloadService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly s3Service: S3Service,
    private httpService: HttpClientService,
    @InjectRepository(DeliveryItemEntity) private readonly deliveryItemRepo: Repository<DeliveryItemEntity>,
  ) { }


  private updateDeliveryStatus(dlvStatus: DeliveryStatusDto, dlvItem: DeliveryItemEntity) {
    dlvStatus.currentTime = new Date();
    this.logger.log(`Update delivery status: ${dlvStatus}`);

    let prepStatus: PrepareStatusEnum;
    if (dlvStatus.deliveryStatus == DeliveryStatusEnum.DOWNLOAD) {
      prepStatus = PrepareStatusEnum.IN_PROGRESS;
    } else if (dlvStatus.deliveryStatus == DeliveryStatusEnum.DONE) {
      prepStatus = PrepareStatusEnum.DONE;
    } else if (dlvStatus.deliveryStatus == DeliveryStatusEnum.ERROR) {
      prepStatus = PrepareStatusEnum.ERROR;
    } else if (dlvStatus.deliveryStatus == DeliveryStatusEnum.DELETED) {
      prepStatus = PrepareStatusEnum.DELETE;
    }

    if (this.config.get("IS_PROXY") === "true") {
      this.httpService.apiUpdateDeliveryStatus(dlvStatus).catch(err => this.logger.error(`Failed to update dlv status, ${err}`));
    }
    this.deliveryItemRepo.update(dlvItem.id, { status: prepStatus, errMsg: dlvItem.errMsg, progress: Math.round(dlvStatus.downloadData || 0) });
  }

  async startDownloadProcess(dlvItem: DeliveryItemEntity, dlvStatus: DeliveryStatusDto, path: string, url: string, dlvSig: any): Promise<void> {
    this.logger.log(`Start downloading for catalogId: ${dlvStatus.catalogId}  - item: ${dlvItem.itemKey}`);

    this.handleDownloadStart(dlvStatus, dlvItem)

    return new Promise<void>(async (resolve, reject) => {
      const hash = this.getHashCreator(dlvItem.hashAlgorithm)
      const pass = this.getPassStream(dlvStatus, dlvItem, hash, reject);

      this.setupRejectInterval(pass, dlvSig)

      let response: AxiosResponse;
      let intervalRef: NodeJS.Timer
      try {
        response = await this.downloadFileWithRetry(pass, url, dlvStatus, dlvItem);

        this.handleDownloadInProgress(dlvStatus, dlvItem)

        const totalLength = response.headers['content-length'];
        this.setDownloadSize(totalLength, dlvItem);

        let lastUploadedLength = 0;
        let lastUpdateTime = Date.now();
        const calculateHandler = (loaded: number) => {
          [lastUpdateTime, lastUploadedLength] = this.calculateDownloadData(dlvStatus, loaded, lastUpdateTime, lastUploadedLength, totalLength);
        }
        intervalRef = setInterval(() => { this.updateDeliveryStatus(dlvStatus, dlvItem) }, UPDATE_INTERVAL_MLS)

        await this.uploadFile(pass, path, dlvStatus, dlvItem, calculateHandler)

        await this.checkDownloadedHash(hash, dlvStatus, dlvItem);
        // await this.checkUploadedHash(path, dlvStatus, dlvItem)

        clearInterval(intervalRef);
        resolve()
      } catch (error) {
        this.logger.error(error)
        clearInterval(intervalRef);
        this.handleDownloadError(dlvStatus, dlvItem, error);
        pass.destroy();
        reject(error)
      }
    })
  }

  getHashCreator(algorithm: HashAlgorithmEnum): Hash {
    switch (algorithm) {
      case HashAlgorithmEnum.SHA256Base64:
      case HashAlgorithmEnum.SHA256Hex:
        return createHash('sha256');
      default:
        return createHash('sha256');

    }
  }

  async checkHash(
    hash: Hash,
    dlvStatus: DeliveryStatusDto,
    dlvItem: DeliveryItemEntity,
  ): Promise<void> {

    if (!dlvItem.hash || !dlvItem.hashAlgorithm) return Promise.resolve()

    this.logger.debug(`Check hash for catalogId: ${dlvStatus.catalogId} - item: ${dlvItem.itemKey}`);

    let hashValue: string;
    switch (dlvItem.hashAlgorithm) {
      case HashAlgorithmEnum.SHA256Base64:
        hashValue = hash.digest("base64");
        break;
      case HashAlgorithmEnum.SHA256Hex:
        hashValue = hash.digest("hex");
        break;
      default:
        hashValue = hash.digest("hex");
        break;
    }

    if (hashValue === dlvItem.hash) {
      return Promise.resolve();
    } else {
      const errMsg = `Checksum failed for catalogId: ${dlvStatus.catalogId} - item: ${dlvItem.itemKey}`;
      const err = new DeliveryError(ErrorCode.DLV_C_NOT_VERIFIED, errMsg);
      return Promise.reject(err);
    }
  }

  async checkDownloadedHash(hash: Hash, dlvStatus: DeliveryStatusDto, dlvItem: DeliveryItemEntity): Promise<void> {
    return this.checkHash(hash, dlvStatus, dlvItem);
  }

  async checkUploadedHash(path: string, dlvStatus: DeliveryStatusDto, dlvItem: DeliveryItemEntity): Promise<void> {
    let hash = await this.s3Service.getHashForFile(path)
    return await this.checkHash(hash, dlvStatus, dlvItem);
  }

  private getPassStream(dlvStatus: DeliveryStatusDto, dlvItem: DeliveryItemEntity, hash: Hash, reject: (reason?: any) => void): stream.PassThrough {
    this.logger.debug(`Get pass stream for catalogId: ${dlvStatus.catalogId} - item: ${dlvItem.itemKey}`);
    const pass = new stream.PassThrough();

    pass.on('data', chunk => {
      hash.update(chunk)
    })

    pass.on('error', err => {
      const errMsg = `Error Streaming from given url to s3 for catalogId ${dlvStatus.catalogId} - item ${dlvItem.itemKey}, ${err}`;
      const dlvErr = new DeliveryError(ErrorCode.DLV_DOWNLOAD, errMsg)
      reject(dlvErr)
      return
    });
    return pass;
  }

  private setupRejectInterval(pass: stream.PassThrough, dlvSig: any) {
    const isRejectInterval = setInterval(() => {
      if (dlvSig.isDlvReject) {
        pass.destroy()
        clearInterval(isRejectInterval)
        return
      }
    }, 1000)
  }


  private async downloadFileWithRetry(pass: stream.Writable, url: string, dlvStatus: DeliveryStatusDto, dlvItem: DeliveryItemEntity) {

    this.logger.debug(`Download file for catalogId: ${dlvStatus.catalogId} - item: ${dlvItem.itemKey}`);

    const maxRetries = 5;
    const baseDelay = 1000; // 1 second

    const retry = async (attempt: number): Promise<AxiosResponse> => {
      try {
        const response = await this.httpService.downloadFileToStream(pass, url, dlvStatus.catalogId, dlvItem.itemKey);
        return response;
      } catch (err) {
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt); // exponential backoff
          this.logger.warn(`Attempt ${attempt} failed for catalogId ${dlvStatus.catalogId} - item ${dlvItem.itemKey}. Retrying in ${delay} ms...`);
          await new Promise(res => setTimeout(res, delay));
          return retry(attempt + 1);
        } else {
          const errMsg = `Failed to download catalogId ${dlvStatus.catalogId} - item ${dlvItem.itemKey}, from url: ${url}, ${err}`;
          const dlvErr = new DeliveryError(ErrorCode.DLV_DOWNLOAD, errMsg);
          this.logger.error(errMsg);
          throw dlvErr;
        }
      }
    };

    return retry(1);
  }

  private uploadFile(pass: stream.PassThrough, path: string, dlvStatus: DeliveryStatusDto, dlvItem: DeliveryItemEntity, calculateHandler: (loaded: number) => void): Promise<void> {

    this.logger.debug(`Upload file for catalogId: ${dlvStatus.catalogId} - item: ${dlvItem.itemKey}`);

    return new Promise<void>((resolve, reject) => {
      const hashDto: HashDto = {
        hash: dlvItem.hash,
        algorithm: dlvItem.hashAlgorithm
      }

      let uploadObservable = this.s3Service.uploadFileFromStream(pass, path, hashDto);
      uploadObservable.subscribe({
        next: (loaded) => {
          calculateHandler(loaded)
        },
        complete: () => {
          this.handleDownloadComplete(dlvStatus, dlvItem);
          resolve()
        },
        error: err => {
          const errMsg = `Error Uploading to s3 for catalogId ${dlvStatus.catalogId} - item ${dlvItem.itemKey}, ${err}`;
          const dlvErr = new DeliveryError(ErrorCode.DLV_DOWNLOAD, errMsg)
          reject(dlvErr)
        },
      })
    })
  }

  setDownloadSize(totalLength: any, dlvItem: DeliveryItemEntity) {
    this.deliveryItemRepo.update(dlvItem.id, { size: totalLength });
  }

  private calculateDownloadData(dlvStatus: DeliveryStatusDto, loaded: number, lastUpdateTime: number, lastUploadedLength: number, totalLength: number) {
    const currentTime = Date.now();
    const timeDiffInSeconds = (currentTime - lastUpdateTime) / 1000;
    const dataUploaded = loaded - lastUploadedLength;
    const downloadSpeedMBps = dataUploaded / (timeDiffInSeconds * 1024 * 1024); // Assuming dataUploaded is in bytes
    const remainingData = totalLength - loaded;
    const downloadEstimateTimeSeconds = remainingData / (downloadSpeedMBps * 1024 * 1024);

    lastUploadedLength = loaded;
    lastUpdateTime = currentTime;

    dlvStatus.bitNumber = loaded;
    dlvStatus.downloadSpeed = downloadSpeedMBps;
    dlvStatus.downloadEstimateTime = Math.round(downloadEstimateTimeSeconds);
    dlvStatus.downloadData = (lastUploadedLength / totalLength) * 100;

    dlvStatus.deliveryStatus = DeliveryStatusEnum.DOWNLOAD;

    return [lastUpdateTime, lastUploadedLength]

  }
  private handleDownloadError(dlvStatus: DeliveryStatusDto, dlvItem: DeliveryItemEntity, err: Error) {
    dlvStatus.deliveryStatus = DeliveryStatusEnum.ERROR;
    dlvStatus.downloadStop = new Date();
    if (err instanceof DeliveryError) {
      dlvItem.errCode = err.errorCode
    } else {
      dlvItem.errCode = ErrorCode.DLV_OTHER
    }
    dlvItem.errMsg = err.message;
    this.updateDeliveryStatus(dlvStatus, dlvItem);
  }

  private async handleDownloadComplete(dlvStatus: DeliveryStatusDto, dlvItem: DeliveryItemEntity) {
    this.logger.log(`Upload Done! for catalogId: ${dlvStatus.catalogId} - item: ${dlvItem.itemKey}`);
    dlvStatus.deliveryStatus = DeliveryStatusEnum.DONE;
    dlvStatus.downloadDone = new Date();
    this.updateDeliveryStatus(dlvStatus, dlvItem);
  }

  private async handleDownloadStart(dlvStatus: DeliveryStatusDto, dlvItem: DeliveryItemEntity) {
    dlvStatus.downloadStart = new Date();
    dlvStatus.deliveryStatus = DeliveryStatusEnum.START;
    dlvStatus.type = ItemTypeEnum.CACHE;
    this.updateDeliveryStatus(dlvStatus, dlvItem);
  }

  private async handleDownloadInProgress(dlvStatus: DeliveryStatusDto, dlvItem: DeliveryItemEntity) {

    dlvStatus.deliveryStatus = DeliveryStatusEnum.DOWNLOAD;
    this.updateDeliveryStatus(dlvStatus, dlvItem);
  }

}