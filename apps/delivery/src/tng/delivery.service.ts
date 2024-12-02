import { S3Service } from '@app/common/AWS/s3.service';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DownloadService } from './download.service';
import { DeliveryEntity } from '@app/common/database/entities/delivery.entity';
import { PrepareDeliveryReqDto, PrepareDeliveryResDto } from '@app/common/dto/delivery';
import { PrepareStatusEnum } from '@app/common/database/entities';

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly s3Service: S3Service,
    private downloadService: DownloadService,
    @InjectRepository(DeliveryEntity) private readonly deliveryRepo: Repository<DeliveryEntity>,
    ){}

 
  async prepareDelivery(prepDlv: PrepareDeliveryReqDto): Promise<PrepareDeliveryResDto>{    
    this.logger.debug(`Prepare Delivery Request ${prepDlv}`);
    const res = new PrepareDeliveryResDto()
    res.catalogId = prepDlv.catalogId;

    let path = `cache/${prepDlv.catalogId}`;

    let dlv = await this.deliveryRepo.findOneBy({catalogId: prepDlv.catalogId});
    switch (dlv?.status){
      case undefined:
        this.logger.debug(`Not found dlv with catalogId: "${prepDlv.catalogId}" start downloading`)
        res.status = PrepareStatusEnum.START;

        dlv = DeliveryEntity.fromPrepDlvReqDto(prepDlv);
        dlv.status = res.status;
        dlv.path = path;
        this.deliveryRepo.save(dlv); 

        this.downloadService.startDownloading(prepDlv.catalogId, path);
        break;

      case PrepareStatusEnum.ERROR:
        this.logger.debug(`Delivery status of catalogId: "${prepDlv.catalogId}" is Error, start downloading again`)
        res.status = PrepareStatusEnum.START;

        dlv = DeliveryEntity.fromPrepDlvReqDto(prepDlv);
        dlv.status = res.status;
        dlv.path = path;
        this.deliveryRepo.save(dlv); 

        this.downloadService.startDownloading(prepDlv.catalogId, path);
        break;

      case PrepareStatusEnum.IN_PROGRESS:
        res.status = PrepareStatusEnum.IN_PROGRESS;
        this.downloadService.startDownloadIfStopped(dlv);
        break;

      case PrepareStatusEnum.START:
        res.status = PrepareStatusEnum.START;
        this.downloadService.startDownloadIfStopped(dlv);
        break;

      case PrepareStatusEnum.DONE:
        res.status = PrepareStatusEnum.DONE;
        res.url = await this.s3Service.generatePresignedUrlForDownload(dlv.path);
        break;
    }
   

    this.logger.debug(`Prepare Delivery res ${res}`);
    return res;
  }


  async getPreparedDeliveryStatus(catalogId: string): Promise<PrepareDeliveryResDto>{
    let dlv = await this.deliveryRepo.findOneBy({catalogId: catalogId});
    if (!dlv){
      throw new NotFoundException(`No delivery with catalogId "${catalogId}" exist`);
    }
    this.downloadService.startDownloadIfStopped(dlv);
    const res = new PrepareDeliveryResDto()
    res.catalogId = dlv.catalogId;
    res.status = dlv.status;
    if (dlv.status == PrepareStatusEnum.DONE){
      res.url = await this.s3Service.generatePresignedUrlForDownload(dlv.path);
    }
    this.logger.debug(`Prepared Delivery res ${res}`);
    return res
  }
}
