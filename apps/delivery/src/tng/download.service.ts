import { DeliveryStatusEnum, ItemTypeEnum, PrepareStatusEnum,  } from "@app/common/database/entities";
import { Injectable, Logger } from "@nestjs/common";
import * as stream from 'stream';
import { HttpClientService } from "./http-client.service";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AxiosResponse } from "axios";
import { DeliveryEntity } from "@app/common/database/entities/delivery.entity";
import { DeliveryStatusDto, PrepareDeliveryReqDto } from "@app/common/dto/delivery";
import { S3Service } from "@app/common/AWS/s3.service";

const UPDATE_INTERVAL_MLS = 5000;

@Injectable()
export class DownloadService{
  private readonly logger = new Logger(DownloadService.name);

  constructor(
    private readonly s3Service: S3Service,
    private httpService: HttpClientService,
    @InjectRepository(DeliveryEntity) private readonly deliveryRepo: Repository<DeliveryEntity>,
    ){}


  private updateDeliveryStatus(dlvStatus: DeliveryStatusDto){
    dlvStatus.currentTime = new Date();
    this.logger.debug(`Update delivery status: ${dlvStatus}`);

    let prepStatus: PrepareStatusEnum;
    if (dlvStatus.deliveryStatus == DeliveryStatusEnum.DOWNLOAD){
      prepStatus = PrepareStatusEnum.IN_PROGRESS;
    }else if (dlvStatus.deliveryStatus == DeliveryStatusEnum.DONE){
      prepStatus = PrepareStatusEnum.DONE;
    }else if (dlvStatus.deliveryStatus == DeliveryStatusEnum.ERROR){
      prepStatus = PrepareStatusEnum.ERROR;
    }
    this.httpService.apiUpdateDeliveryStatus(dlvStatus).catch(err => this.logger.error(`Failed to update dlv status, ${err}`));
    this.deliveryRepo.update(dlvStatus.catalogId, {status: prepStatus});
  }
  
  private async getDownloadUrl(catalogId: string, deviceId: string): Promise<string>{
    let prepReq = new PrepareDeliveryReqDto();
    prepReq.catalogId = catalogId;
    prepReq.deviceId = deviceId;
    prepReq.itemType = ItemTypeEnum.CACHE;
  
    let prepRes = await this.httpService.apiPrepareDelivery(prepReq);

    if (prepRes.status == PrepareStatusEnum.ERROR){
      throw Error("Prepare status from server is Error");
    }
    return prepRes.url;
  }

  async startDownloading(catalogId: string, path: string){
    let dlvStatus = new DeliveryStatusDto()
    dlvStatus.catalogId = catalogId
    dlvStatus.deviceId = 'TNG' // todo
    this.handleDownloadStart(dlvStatus)
    
    let url: string;
    try {
      url = await this.getDownloadUrl(dlvStatus.catalogId, dlvStatus.deviceId);
    }catch(err){
      this.logger.error(`Error Get Download Url for catalogId: ${dlvStatus.catalogId}, ${err}`);
      return this.handleDownloadError(dlvStatus);
    }

    const pass = new stream.PassThrough();

    let response: AxiosResponse;
    try{
      response = await this.httpService.downloadFileToStream(pass, url, catalogId);
    }catch(err){
      this.logger.error(`Fail to download catalogId ${catalogId}, ${err}`);
      return this.handleDownloadError(dlvStatus);
    }
    
    let uploadObservable = this.s3Service.uploadFileFromStream(pass, path);
    
    const totalLength = response.headers['content-length'];
    let lastUploadedLength = 0;
    let lastUpdateTime = Date.now();

    let intervalRef = setInterval(() => {this.updateDeliveryStatus(dlvStatus)}, UPDATE_INTERVAL_MLS)

    uploadObservable.subscribe({
      next: (loaded) => {
        [lastUpdateTime, lastUploadedLength] = this.calculateDownloadData(dlvStatus, loaded, lastUpdateTime, lastUploadedLength, totalLength);
      },
      complete: () => {
        clearInterval(intervalRef)
        this.handleDownloadComplete(dlvStatus);
      },
      error: err => {
        this.logger.error(`Error Uploading the file ${dlvStatus.catalogId} to s3, ${err}`);
        pass.destroy(err);
      },
      
    })
    pass.on('error', err => {
      this.logger.error("Stream was destroyed");
      this.handleDownloadError(dlvStatus);
      clearInterval(intervalRef);
    });    
    return 
  }
  
  private calculateDownloadData(dlvStatus: DeliveryStatusDto, loaded: number, lastUpdateTime: number, lastUploadedLength: number, totalLength: number){
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
  private async handleDownloadError(dlvStatus: DeliveryStatusDto) {
    dlvStatus.deliveryStatus = DeliveryStatusEnum.ERROR;
    dlvStatus.downloadStop = new Date();
    await this.updateDeliveryStatus(dlvStatus);
  }

  private async handleDownloadComplete(dlvStatus: DeliveryStatusDto) {
    this.logger.log(`Upload Done! for catalogId: ${dlvStatus.catalogId}`);
    dlvStatus.deliveryStatus = DeliveryStatusEnum.DONE;
    dlvStatus.downloadDone = new Date();
    await this.updateDeliveryStatus(dlvStatus);
  }

  private async handleDownloadStart(dlvStatus: DeliveryStatusDto) {
    dlvStatus.downloadStart = new Date();
    dlvStatus.deliveryStatus = DeliveryStatusEnum.START;
    dlvStatus.type = ItemTypeEnum.CACHE;
    await this.updateDeliveryStatus(dlvStatus);
  }

  async startDownloadIfStopped(dlv: DeliveryEntity){
    const startDownloadAgain = (d: DeliveryEntity) => {
      return d && 
        (d.status === PrepareStatusEnum.START || d.status === PrepareStatusEnum.IN_PROGRESS) && 
        Date.now() - d.lastUpdatedDate.getTime() > UPDATE_INTERVAL_MLS + 1000
      };
        
    if (!startDownloadAgain(dlv)){
      return
    }

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    await delay(UPDATE_INTERVAL_MLS + 1000);
    dlv = await this.deliveryRepo.findOneBy({catalogId: dlv.catalogId});

    if (!startDownloadAgain(dlv)){
      return
    }

    this.logger.debug(`Downloading catalogId ${dlv.catalogId} stopped, Start again`);
    this.startDownloading(dlv.catalogId, dlv.path);
    
  }

}