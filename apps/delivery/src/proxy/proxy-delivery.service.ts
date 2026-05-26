import { Injectable, Logger } from '@nestjs/common';
import { PrepareDeliveryReqDto, PrepareDeliveryResDto } from '@app/common/dto/delivery';
import { ItemTypeEnum, PrepareStatusEnum } from '@app/common/database/entities';
import { DeliveryEntity } from '@app/common/database-proxy/entities';
import { HttpClientService } from './http-client.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private httpService: HttpClientService,
    private readonly config: ConfigService,
    @InjectRepository(DeliveryEntity) private readonly deliveryRepo: Repository<DeliveryEntity>
  ) { }


  async getDeliveryResources(dlv: DeliveryEntity): Promise<PrepareDeliveryResDto> {
    try {
      return await this.getDeliveryArtifacts(dlv);
    } catch (err) {
      let errMes = `Error Get Download Url for catalogId: ${dlv.catalogId}, ${err}`
      this.logger.error(errMes);
      throw err
    }
  }


  private async getDeliveryArtifacts(dlv: DeliveryEntity): Promise<PrepareDeliveryResDto> {
    let prepReq = new PrepareDeliveryReqDto();
    prepReq.catalogId = dlv.catalogId;
    prepReq.deviceId = this.config.get("SERVER_NAME") || "delivery-proxy";
    prepReq.itemType = ItemTypeEnum.CACHE;
  
    let prepRes = await this.httpService.apiPrepareDelivery(prepReq);
    if (prepRes.status == PrepareStatusEnum.IN_PROGRESS || prepRes.status == PrepareStatusEnum.START) {
      // dlv.status = PrepareStatusEnum.PENDING;
      dlv.progress = prepRes.progress;
      dlv.lastUpdatedDate = new Date();
      await this.deliveryRepo.save(dlv);

      do {
        /**
         * TODO: if status is in progress, is needed the update dlv status to pending, (needed to add pending option in @Params PrepareStatusEnum)
         **/
        await new Promise(resolve => setTimeout(resolve, 2000));
        prepRes = await this.httpService.apiGetPreparedDelivery(dlv.catalogId);
        dlv.lastUpdatedDate = new Date()
        dlv.progress = prepRes.progress;
        this.deliveryRepo.save(dlv)
      } while (prepRes.status == PrepareStatusEnum.IN_PROGRESS || prepRes.status == PrepareStatusEnum.START);
    }

    if (prepRes.status == PrepareStatusEnum.ERROR) {
      throw Error("Prepare status from server is Error");
    }

    return PrepareDeliveryResDto.fromPrepareDeliveryResDto(prepRes);
  }

  async applyOriginMetadata(res: PrepareDeliveryResDto, deviceId: string): Promise<void> {
    if (res.status !== PrepareStatusEnum.DONE || !res.Artifacts || res.Artifacts.length === 0) return;

    try {
      const prepReq = new PrepareDeliveryReqDto();
      prepReq.catalogId = res.catalogId;
      prepReq.deviceId = deviceId;
      prepReq.itemType = ItemTypeEnum.CACHE;

      const originRes = await this.httpService.apiPrepareDelivery(prepReq);
      if (originRes.status !== PrepareStatusEnum.DONE || !originRes.Artifacts) return;

      for (const cachedArt of res.Artifacts) {
        const originArt = originRes.Artifacts.find(a => a.itemKey === cachedArt.itemKey);
        if (originArt) {
          cachedArt.isExecutable = originArt.isExecutable;
        }
      }
    } catch (err) {
      this.logger.warn(`Failed to get origin metadata for catalogId ${res.catalogId}: ${err}`);
    }
  }

}
