import { Injectable, Logger } from '@nestjs/common';
import { PrepareDeliveryReqDto, PrepareDeliveryResDto } from '@app/common/dto/delivery';
import { ItemTypeEnum, PrepareStatusEnum } from '@app/common/database/entities';
import { DeliveryError } from '@app/common/dto/delivery/dto/delivery-error';
import { ErrorCode } from '@app/common/dto/error';
import { DeliveryEntity } from '@app/common/database-tng/entities';
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
      if (err instanceof DeliveryError) {
        throw err;
      }
      const errMes = `Error Get Download Url for catalogId: ${dlv.catalogId}, ${err}`;
      this.logger.error(errMes);
      throw new DeliveryError(ErrorCode.DLV_OTHER, errMes);
    }
  }


  private async getDeliveryArtifacts(dlv: DeliveryEntity): Promise<PrepareDeliveryResDto> {
    let prepReq = new PrepareDeliveryReqDto();
    prepReq.catalogId = dlv.catalogId;
    prepReq.deviceId = this.config.get("SERVER_NAME") || "delivery-proxy";
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

    if (prepRes.status == PrepareStatusEnum.ERROR) {
      const msg = prepRes.error?.message || `Prepare delivery failed with error status for catalogId: ${dlv.catalogId}`;
      const errorCode = prepRes.error?.errorCode || ErrorCode.DLV_C_INVALID;
      this.logger.error(msg);
      throw new DeliveryError(errorCode, msg);
    }

    return PrepareDeliveryResDto.fromPrepareDeliveryResDto(prepRes);
  }

}
