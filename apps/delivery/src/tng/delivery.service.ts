import { Injectable, Logger } from '@nestjs/common';
import { PrepareDeliveryReqDto, PrepareDeliveryResDto } from '@app/common/dto/delivery';
import { ItemTypeEnum, PrepareStatusEnum } from '@app/common/database/entities';
import { DeliveryEntity } from '@app/common/database-tng/entities';
import { HttpClientService } from './http-client.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private httpService: HttpClientService,
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
    prepReq.deviceId = dlv.deviceId;
    prepReq.itemType = ItemTypeEnum.CACHE;

    let prepRes = await this.httpService.apiPrepareDelivery(prepReq);        
    if (prepRes.status == PrepareStatusEnum.IN_PROGRESS || prepRes.status == PrepareStatusEnum.START) {
      do {
        /**
         * TODO: if status is in progress, is needed the update dlv status to pending, (needed to add pending option in @Params PrepareStatusEnum)
         **/
        await new Promise(resolve => setTimeout(resolve, 2000));
        prepRes = await this.httpService.apiGetPreparedDelivery(dlv.catalogId);
        dlv.lastUpdatedDate = new Date()
        this.deliveryRepo.save(dlv)        
      } while (prepRes.status == PrepareStatusEnum.IN_PROGRESS || prepRes.status == PrepareStatusEnum.START);
    }

    if (prepRes.status == PrepareStatusEnum.ERROR || (prepRes.status == PrepareStatusEnum.DONE && !prepRes.url)) {
      throw Error("Prepare status from server is Error");
    }

    return PrepareDeliveryResDto.fromPrepareDeliveryResDto(prepRes);
  }

}
