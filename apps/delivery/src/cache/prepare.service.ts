import { S3Service } from '@app/common/AWS/s3.service';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DownloadService } from './download.service';
import { DeliveryStatusDto, PrepareDeliveryReqDto, PrepareDeliveryResDto } from '@app/common/dto/delivery';
import { PrepareStatusEnum } from '@app/common/database/entities';
import { DeliveryEntity, DeliveryItemEntity } from '@app/common/database-tng/entities';
import { HttpClientService } from './http-client.service';
import { DeliveryItemDto, HashDto } from '@app/common/dto/delivery/dto/delivery-item.dto';
import { ManagementService } from './management.service';
import { ErrorCode, ErrorDto } from '@app/common/dto/error';
import { DeliveryError } from '@app/common/dto/delivery/dto/delivery-error';

const UPDATE_INTERVAL_MLS = 5000;

@Injectable()
export class PrepareService {
  private readonly logger = new Logger(PrepareService.name);

  constructor(
    private mngService: ManagementService,
    private downloadService: DownloadService,
    private httpService: HttpClientService,
    private readonly s3Service: S3Service,
    @InjectRepository(DeliveryEntity) private readonly deliveryRepo: Repository<DeliveryEntity>,
    @InjectRepository(DeliveryItemEntity) private readonly deliveryItemRepo: Repository<DeliveryItemEntity>,
  ) { }


  async prepareDelivery(prepDlv: PrepareDeliveryReqDto, dlvSrcFn: (dlv: DeliveryEntity) => Promise<PrepareDeliveryResDto>): Promise<PrepareDeliveryResDto> {

    this.logger.debug(`Prepare Delivery Request ${prepDlv}`);
    const res = new PrepareDeliveryResDto()
    res.catalogId = prepDlv.catalogId;

    let dlv = await this.deliveryRepo.findOneBy({ catalogId: prepDlv.catalogId });
    switch (dlv?.status) {
      case undefined:
        this.logger.debug(`Not found dlv with catalogId: "${prepDlv.catalogId}" start downloading`)
        res.status = PrepareStatusEnum.START;

        dlv = DeliveryEntity.fromPrepDlvReqDto(prepDlv);
        dlv.status = res.status;
        this.deliveryRepo.save(dlv);

        this.preparationForDownload(dlv, dlvSrcFn);
        break;

      case PrepareStatusEnum.ERROR:
      case PrepareStatusEnum.DELETE:
        this.logger.debug(`Delivery status of catalogId: "${prepDlv.catalogId}" is ${dlv.status}, start downloading again`)
        res.status = PrepareStatusEnum.START

        this.preparationForDownload(dlv, dlvSrcFn);
        break;

      case PrepareStatusEnum.IN_PROGRESS:
        res.status = PrepareStatusEnum.IN_PROGRESS;
        this.startDeliveryIfStooped(dlv, dlvSrcFn);
        break;

      case PrepareStatusEnum.START:
        res.status = PrepareStatusEnum.START;
        this.startDeliveryIfStooped(dlv, dlvSrcFn);
        break;

      case PrepareStatusEnum.DONE:
        await this.getPreparedDeliveryDone(res, dlv)
        break;
    }

    this.logger.debug(`Prepare Delivery - res ${res}`);
    return res;
  }

  async getDeliverySrc(dlvSrcFn: (dlv: DeliveryEntity) => Promise<PrepareDeliveryResDto>, dlv: DeliveryEntity) {
    try {
      const res = await dlvSrcFn(dlv)
      if (res.error) {
        throw new DeliveryError(res.error.errorCode, res.error.message)
      }
      return res
    } catch (err) {
      const errMsg = `Fail to get delivery source for catalog Id '${dlv.catalogId}, ${err}`
      this.logger.error(errMsg)
      throw err
    }
  }


  async getPreparedDeliveryStatus(catalogId: string, dlvSrcFn: (dlv: DeliveryEntity) => Promise<PrepareDeliveryResDto>): Promise<PrepareDeliveryResDto> {

    let dlv = await this.deliveryRepo.findOneBy({ catalogId: catalogId });
    if (!dlv) {
      throw new NotFoundException(`No delivery with catalogId "${catalogId}" exist`);
    }

    const res = new PrepareDeliveryResDto()
    res.catalogId = dlv.catalogId;
    res.status = dlv.status;
    if (dlv.status == PrepareStatusEnum.DONE) {
      await this.getPreparedDeliveryDone(res, dlv)
    } else if (dlv.status === PrepareStatusEnum.ERROR) {
      res.error = new ErrorDto()
      res.error.errorCode = ErrorDto.parseErrorCodeStrToEnum(dlv.errCode)
      res.error.message = dlv.errMsg
    } else if (dlv.status === PrepareStatusEnum.DELETE) {
      res.status = PrepareStatusEnum.DELETE
      if(dlv.errCode || dlv.errMsg){   
        res.error = new ErrorDto()
        res.error.errorCode = ErrorDto.parseErrorCodeStrToEnum(dlv.errCode)
        res.error.message = dlv.errMsg
      }
    } else {
      res.progress = await this.getMinProgressFromDlvItems(dlv);
    }

    this.startDeliveryIfStooped(dlv, dlvSrcFn);

    this.logger.debug(`Prepared Delivery res ${res}`);
    return res
  }

  async getPreparedDeliveryDone(res: PrepareDeliveryResDto, dlv: DeliveryEntity): Promise<void> {
    res.status = PrepareStatusEnum.DONE;
    res.progress = 100;
    res.Artifacts = await Promise.all((await this.getDeliveryItems(dlv)).map(async (item, i) => {
      const resDto = DeliveryItemDto.fromDeliveryItemEntity(item)
      resDto.url = await this.s3Service.generatePresignedUrlForDownload(item.path)
      if (i === 0 || item.itemKey === 'gpkg') {
        res.url = resDto.url
      }
      if (item.hash && item.hashAlgorithm) {
        resDto.hash = new HashDto()
        resDto.hash.hash = item.hash
        resDto.hash.algorithm = item.hashAlgorithm
      }

      resDto.hash
      return resDto
    }))

  }

  async getMinProgressFromDlvItems(dlv: DeliveryEntity): Promise<number> {
    let deliveryItems = await this.getDeliveryItems(dlv)
    if (!deliveryItems || deliveryItems.length === 0) {
      this.logger.warn(`No delivery items found for catalogId: ${dlv.catalogId}`);
      return 0;
    }
    return deliveryItems.map(item => item.progress).reduce((a, b) => Math.min(a, b));
  }

  async preparationForDownload(dlv: DeliveryEntity, dlvSrcFn: (dlv: DeliveryEntity) => Promise<PrepareDeliveryResDto>) {
    this.logger.log(`Prepare downloading for catalog id ${dlv.catalogId}`)
    this.handleDeliveryStart(dlv)

    let dlvSignals = { isDlvReject: false }
    try {

      const dlvSrc = await this.getDeliverySrc(dlvSrcFn, dlv)

      const dlvMetaData = await Promise.all(dlvSrc.Artifacts.map(async (art) => await this.getArtMetaData(art)))
      const dlvItemSizes = dlvMetaData.map(md => md.totalLength)
      await this.updateDlvSizeBySizeArr(dlvItemSizes, dlv)

      if (!(await this.mngService.isEnableCachingDelivery(dlv.size, dlv.catalogId))) {
        try {
          await this.mngService.deleteDeliveryBySize(dlv.size, dlv.catalogId)
        } catch (error) {
          if (error instanceof DeliveryError) {
            this.logger.error(error)
            this.handleDeliveryError(dlv, error);
          } else {
            const errMsg = `There is no space to enable caching, Error: ${error}`;
            this.logger.error(errMsg)
            this.handleDeliveryError(dlv, new DeliveryError(ErrorCode.DLV_C_CLEAR_ISSUE, errMsg));
          }
          return
        }
      }

      this.handleDeliveryInProgress(dlv)
      await Promise.all(dlvSrc.Artifacts.map(async (art) => await this.prepareItemToDownload(dlv, art, dlvSignals)))

      this.handleDeliverySuccess(dlv)

    } catch (err) {
      dlvSignals.isDlvReject = true

      if (err instanceof DeliveryError) {
        this.logger.error(err)
        this.handleDeliveryError(dlv, err);
      } else {
        const errMsg = `Error in delivery process for catalogId: ${err}`;
        this.logger.error(errMsg)
        err.message = errMsg
        this.handleDeliveryError(dlv, err);
      }
      return
    }
  }
  
  async getArtMetaData(art: DeliveryItemDto): Promise<{ totalLength: number; }> {
    const headers = await this.httpService.getUrlHead(art.url)
    const totalLength = Number(headers['content-length']);
    return { totalLength }
  }

  async handleDeliverySuccess(dlv: DeliveryEntity) {
    await this.updateDlvSizeByItsItems(dlv);
    this.handleDeliveryComplete(dlv);
  }

  async updateDlvSizeByItsItems(dlv: DeliveryEntity) {
    const dlvItems = await this.deliveryItemRepo.find({ where: { delivery: { catalogId: dlv.catalogId } } })
    if (dlvItems && dlvItems.length > 0) {
      dlv.size = dlvItems.map(item => item.size).reduce((a, b) => a + b, 0);
    }
  }

  async updateDlvSizeBySizeArr(sizes: number[], dlv: DeliveryEntity) {
    dlv.size = sizes.reduce((a, b) => a + b, 0)
    await this.deliveryRepo.update(dlv.catalogId, { size: dlv.size })
  }

  async prepareItemToDownload(dlv: DeliveryEntity, art: DeliveryItemDto, dlvSig: any): Promise<void> {    
    let path = `${art.metaData}/${dlv.catalogId}${art.url.substring(art.url.lastIndexOf("/"), art.url.includes("?") ? art.url.indexOf("?") : art.url.length)}`;
    let dlvItem = await this.deliveryItemRepo.findOne({ where: { delivery: { catalogId: dlv.catalogId }, itemKey: art.itemKey } })

    if (!dlvItem) {
      dlvItem = new DeliveryItemEntity()
      dlvItem.delivery = dlv
      dlvItem.itemKey = art.itemKey
      dlvItem.metaData = art.metaData
    }

    dlvItem.path = path
    dlvItem.status = PrepareStatusEnum.START
    dlvItem.errMsg = null
    dlvItem.progress = 0
    dlvItem.size = null
    dlvItem.hash = art.hash?.hash
    dlvItem.hashAlgorithm = art.hash?.algorithm
    dlvItem = await this.deliveryItemRepo.save(dlvItem)

    let dlvStatus = new DeliveryStatusDto()
    dlvStatus.catalogId = dlv.catalogId
    dlvStatus.deviceId = 'TNG' // todo
    dlvStatus.itemKey = dlvItem.itemKey

    return this.downloadService.startDownloadProcess(dlvItem, dlvStatus, path, art.url, dlvSig);

  }

  // TODO needs a test
  async startDeliveryIfStooped(dlv: DeliveryEntity, dlvSrcFn: (dlv: DeliveryEntity) => Promise<PrepareDeliveryResDto>) {
    
    const isDownloadStooped = async () => {
      const delivery = await this.deliveryRepo.findOneBy({ catalogId: dlv.catalogId })
      const deliveryItems = await this.getDeliveryItems(dlv)
      const isDownloading = delivery.status === PrepareStatusEnum.START || delivery.status === PrepareStatusEnum.IN_PROGRESS;
      const hasItems = deliveryItems && deliveryItems.length > 0;
      const lastUpdated = Math.max(
        deliveryItems.map(item => item.lastUpdatedDate.getTime()).reduce((a, b) => Math.max(a, b), 0),
        delivery.lastUpdatedDate.getTime()
      );
      const isStale = Date.now() - lastUpdated > UPDATE_INTERVAL_MLS + 1000;

      return isDownloading && (!hasItems || isStale);
    };

    if (!(await isDownloadStooped())) {
      return
    }

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    await delay(UPDATE_INTERVAL_MLS + 1000);

    if (!(await isDownloadStooped())) {
      return
    } else {
      this.logger.debug(`Downloading catalogId ${dlv.catalogId} stopped, Start again`);
      this.preparationForDownload(dlv, dlvSrcFn);
    }
  }

  async getDeliveryItems(dlv: DeliveryEntity): Promise<DeliveryItemEntity[]> {
    return this.deliveryItemRepo.find({ where: { delivery: { catalogId: dlv.catalogId }, }, relations: ['delivery'] })
  }

  async handleDeliveryError(dlv: DeliveryEntity, err: Error) {
    this.logger.debug(`Update delivery entity for catalogId ${dlv.catalogId} to status: ${PrepareStatusEnum.ERROR}`)
    if (err instanceof DeliveryError) {
      dlv.errCode = err.errorCode
    } else {
      dlv.errCode = ErrorCode.DLV_OTHER
    }
    dlv.errMsg = err.message
    dlv.status = PrepareStatusEnum.ERROR
    this.deliveryRepo.update(dlv.catalogId, dlv);
  }

  private async handleDeliveryComplete(dlv: DeliveryEntity) {
    this.logger.debug(`Update delivery entity for catalogId ${dlv.catalogId} to status: ${PrepareStatusEnum.DONE}`)
    dlv.status = PrepareStatusEnum.DONE;
    this.deliveryRepo.update(dlv.catalogId, dlv);
  }

  async handleDeliveryStart(dlv: DeliveryEntity) {
    this.logger.debug(`Update delivery entity for catalogId ${dlv.catalogId} to status: ${PrepareStatusEnum.START}`)
    dlv.status = PrepareStatusEnum.START
    dlv.errMsg = null
    dlv.errCode = null
    dlv.size = 0
    this.deliveryRepo.update(dlv.catalogId, dlv);
  }

  private async handleDeliveryInProgress(dlv: DeliveryEntity) {
    this.logger.debug(`Update delivery entity for catalogId ${dlv.catalogId} to status: ${PrepareStatusEnum.IN_PROGRESS}`)
    dlv.status = PrepareStatusEnum.IN_PROGRESS
    this.deliveryRepo.update(dlv.catalogId, { status: PrepareStatusEnum.IN_PROGRESS });
  }

}
