import { S3Service } from "@app/common/AWS/s3.service";
import { DeliveryEntity, DeliveryStatusEnum, ItemTypeEnum, PrepareStatusEnum } from "@app/common/database/entities";
import { DeliveryStatusDto, PrepareDeliveryReqDto, PrepareDeliveryResDto } from "@app/common/dto/delivery";
import { HttpService } from "@nestjs/axios";
import { Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { AxiosResponse } from "axios";
import * as stream from 'stream';
import { Repository } from "typeorm";

const REQUEST_TIME_OUT = 10000;
const UPDATE_INTERVAL_MLS = 5000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class PrepareService{
  private readonly logger = new Logger(PrepareService.name);
  constructor(
    private httpService: HttpService,
    private readonly s3Service: S3Service,
    @InjectRepository(DeliveryEntity) private readonly deliveryRepo: Repository<DeliveryEntity>,
    ){
      
    }


  async prepareDelivery(prepDlv: PrepareDeliveryReqDto, url: string): Promise<PrepareDeliveryResDto>{    
    this.logger.debug(`Prepare Delivery Request ${prepDlv}`);
    const res = new PrepareDeliveryResDto()
    res.catalogId = prepDlv.catalogId;

    let path = `cache-public/${prepDlv.catalogId}`;
    if(prepDlv.itemType == ItemTypeEnum.MAP){
      const fileName = url.substring(url.lastIndexOf("/"))
      path  = path + fileName
      this.logger.debug(`Save map to path: ${path}`)
    }

    let dlv = await this.deliveryRepo.findOneBy({catalogId: prepDlv.catalogId});
    switch (dlv?.status){
      case undefined:
        this.logger.debug(`Not found dlv with catalogId: "${prepDlv.catalogId}" start downloading`)
        res.status = PrepareStatusEnum.START;

        dlv = DeliveryEntity.fromPrepDlvReqDto(prepDlv);
        dlv.status = res.status;
        dlv.path = path;
        this.deliveryRepo.save(dlv); 

        this.startDownloading(prepDlv.deviceId, prepDlv.catalogId, path, url);
        break;

      case PrepareStatusEnum.ERROR:
        this.logger.debug(`Delivery status of catalogId: "${prepDlv.catalogId}" is Error, start downloading again`)
        res.status = PrepareStatusEnum.START;

        dlv = DeliveryEntity.fromPrepDlvReqDto(prepDlv);
        dlv.status = res.status;
        dlv.path = path;
        this.deliveryRepo.save(dlv); 

        this.startDownloading(prepDlv.deviceId, prepDlv.catalogId, path, url);
        break;

      case PrepareStatusEnum.IN_PROGRESS:
        res.status = PrepareStatusEnum.IN_PROGRESS;
        this.startDownloadIfStopped(dlv, url);
        break;

      case PrepareStatusEnum.START:
        res.status = PrepareStatusEnum.START;
        this.startDownloadIfStopped(dlv, url);
        break;

      case PrepareStatusEnum.DONE:
        res.status = PrepareStatusEnum.DONE;
        res.url = await this.s3Service.generatePresignedUrlForDownload(dlv.path);
        break;
    }
   

    this.logger.debug(`Prepare Delivery res ${res}`);
    return res;
  }


  async getPreparedDeliveryStatus(catalogId: string, url: string): Promise<PrepareDeliveryResDto>{
    let dlv = await this.deliveryRepo.findOneBy({catalogId: catalogId});
    if (!dlv){
      throw new NotFoundException(`No delivery with catalogId "${catalogId}" exist`);
    }
    // TODO
    this.startDownloadIfStopped(dlv, url);
    const res = new PrepareDeliveryResDto()
    res.catalogId = dlv.catalogId;
    res.status = dlv.status;
    if (dlv.status == PrepareStatusEnum.DONE){
      res.url = await this.s3Service.generatePresignedUrlForDownload(dlv.path);
    }
    this.logger.debug(`Prepared Delivery res ${res}`);
    return res
  }



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
    // this.httpService.apiUpdateDeliveryStatus(dlvStatus).catch(err => this.logger.error(`Failed to update dlv status, ${err}`));
    this.deliveryRepo.update(dlvStatus.catalogId, {status: prepStatus, progress: Math.round(dlvStatus.downloadData || 0)});
  }
  
  private changeExtensionToJson(s: string): string{
    return s.substring(0, s.lastIndexOf(".")) + ".json"
  }

  private async downloadJson(catalogId: string, path: string, url: string): Promise<boolean>{
    let jsonPath = this.changeExtensionToJson(path)
    let jsonUrl = this.changeExtensionToJson(url)

    this.logger.debug("Json download url: " + jsonUrl)
    const pass = new stream.PassThrough();

    return new Promise<boolean>(async (resolve) => {
      let response: AxiosResponse;
      try{
        response = await this.downloadFileToStream(pass, jsonUrl, catalogId + "-json");
      }catch(err){
        this.logger.error(`Fail to download json catalogId ${catalogId}, ${err}`);
        resolve(false)
        return
      }
      let uploadObservable = this.s3Service.uploadFileFromStream(pass, jsonPath);

      uploadObservable.subscribe({
        complete: () => {
          this.logger.log("Finish to upload json file, of catalogId: " + catalogId)
          resolve(true)
        },
        error: err => {
          this.logger.error(`Error Uploading the json file of catalogId: ${catalogId} to s3, ${err}`);
          pass.destroy(err);
          resolve(false)
        },
        
      })
      pass.on('error', err => {
        this.logger.error("Stream was destroyed");
        resolve(false)
      }); 

    })

  }
  
  private async downloadJsonRetry(catalogId: string, path: string, url: string){
    let success = false
    let attempts = 1
    do {
      this.logger.debug(`download json: ${catalogId}, attempt: ${attempts}`)
      success = await this.downloadJson(catalogId, path, url)
      attempts++
      await delay(2000)
    }while(!success && attempts < 5)
  }

  private async downloadMap(dlvStatus: DeliveryStatusDto, catalogId: string, path: string, url: string): Promise<boolean>{
    const pass = new stream.PassThrough();

    return new Promise<boolean> (async (resolve) => {
      let response: AxiosResponse;
      try{
        response = await this.downloadFileToStream(pass, url, catalogId);
      }catch(err){
        this.logger.error(`Fail to download catalogId ${catalogId}, ${err}`);
        resolve(false)
        // return this.handleDownloadError(dlvStatus);
        return
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
          // this.handleDownloadComplete(dlvStatus);
          resolve(true)
        },
        error: err => {
          this.logger.error(`Error Uploading the file ${dlvStatus.catalogId} to s3, ${err}`);
          pass.destroy(err);
        },
        
      })
      pass.on('error', err => {
        this.logger.error("Stream was destroyed");
        // this.handleDownloadError(dlvStatus);
        clearInterval(intervalRef);
        resolve(false)
      });  
    })
    
  }

  private async downloadMapRetry(dlvStatus: DeliveryStatusDto, catalogId: string, path: string, url: string){
    let success = false
    let attempts = 1
    do {
      this.logger.debug(`download map: ${catalogId}, attempt: ${attempts}`)
      if(attempts > 1){
        await delay(2000)
      }
      success = await this.downloadMap(dlvStatus, catalogId, path, url)
      attempts++
    }while(!success && attempts < 5)

    if(success){
      this.handleDownloadComplete(dlvStatus);
    }else{
      this.handleDownloadError(dlvStatus);
    }
  }

  async startDownloading(deviceId: string, catalogId: string, path: string, url: string){
    let dlvStatus = new DeliveryStatusDto()
    dlvStatus.catalogId = catalogId
    dlvStatus.deviceId = deviceId // todo
    this.handleDownloadStart(dlvStatus)

    this.downloadJsonRetry(catalogId, path, url)

    this.downloadMapRetry(dlvStatus, catalogId, path, url)
    
    // let url: string;
    // try {
    //   url = await this.getDownloadUrl(dlvStatus.catalogId, dlvStatus.deviceId);
    // }catch(err){
    //   this.logger.error(`Error Get Download Url for catalogId: ${dlvStatus.catalogId}, ${err}`);
    //   return this.handleDownloadError(dlvStatus);
    // }

    // const pass = new stream.PassThrough();

    // let response: AxiosResponse;
    // try{
    //   response = await this.downloadFileToStream(pass, url, catalogId);
    // }catch(err){
    //   this.logger.error(`Fail to download catalogId ${catalogId}, ${err}`);
    //   return this.handleDownloadError(dlvStatus);
    // }
    
    // let uploadObservable = this.s3Service.uploadFileFromStream(pass, path);
    
    // const totalLength = response.headers['content-length'];
    // let lastUploadedLength = 0;
    // let lastUpdateTime = Date.now();

    // let intervalRef = setInterval(() => {this.updateDeliveryStatus(dlvStatus)}, UPDATE_INTERVAL_MLS)

    // uploadObservable.subscribe({
    //   next: (loaded) => {
    //     [lastUpdateTime, lastUploadedLength] = this.calculateDownloadData(dlvStatus, loaded, lastUpdateTime, lastUploadedLength, totalLength);
    //   },
    //   complete: () => {
    //     clearInterval(intervalRef)
    //     this.handleDownloadComplete(dlvStatus);
    //   },
    //   error: err => {
    //     this.logger.error(`Error Uploading the file ${dlvStatus.catalogId} to s3, ${err}`);
    //     pass.destroy(err);
    //   },
      
    // })
    // pass.on('error', err => {
    //   this.logger.error("Stream was destroyed");
    //   this.handleDownloadError(dlvStatus);
    //   clearInterval(intervalRef);
    // });    
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

  async startDownloadIfStopped(dlv: DeliveryEntity, url: string){
    const startDownloadAgain = (d: DeliveryEntity) => {
      return d && 
        (d.status === PrepareStatusEnum.START || d.status === PrepareStatusEnum.IN_PROGRESS) && 
        Date.now() - d.lastUpdatedDate.getTime() > (UPDATE_INTERVAL_MLS + 1000)
      };
    

    if (!startDownloadAgain(dlv)){
      return
    }

    await delay(UPDATE_INTERVAL_MLS + 1000);
    dlv = await this.deliveryRepo.findOneBy({catalogId: dlv.catalogId});

    if (!startDownloadAgain(dlv)){
      return
    }

    this.logger.debug(`Downloading catalogId ${dlv.catalogId} stopped, Start again`);
    this.startDownloading(dlv.deviceId, dlv.catalogId, dlv.path, url);
    
  }


  private async downloadFileToStream(outputStream: stream.Writable, url: string, catalogId: string): Promise<AxiosResponse> {
    this.httpService.axiosRef.defaults.baseURL = ''
    this.httpService.axiosRef.defaults.httpsAgent = undefined
    const response = await this.httpService.axiosRef.get(url, { responseType: 'stream', timeout: REQUEST_TIME_OUT });
    response.data.pipe(outputStream)

    const totalLength = response.headers['content-length'];
    let downloadedLength = 0;
    let lastLogTime = Date.now();

    response.data.on('data', (chunk: any) => {
      downloadedLength += chunk.length;
      let currentLogTime = Date.now();

      if (currentLogTime - lastLogTime > 5000) {
        lastLogTime = currentLogTime;
        const progress = (downloadedLength / totalLength) * 100;
        this.logger.verbose(`Downloading... ${progress.toFixed(2)}%, of catalogId: ${catalogId}`);
      }

    });
    response.data.on('error', (err: any) => {
      this.logger.error(`Error downloading catalogId ${catalogId} from url ${url}, ${err}`);
      outputStream.destroy(err)
    });

    return response;
  }
}