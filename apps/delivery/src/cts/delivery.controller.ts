import { DeliveryTopics } from '@app/common/microservice-client/topics';
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, EventPattern } from '@nestjs/microservices';
import { DeliveryService } from './delivery.service';
import { PrepareDeliveryReqDto } from '@app/common/dto/delivery';
import { ConfigService } from '@nestjs/config';
import { PrepareService } from '../cache/prepare.service';
import { DeliveryEntity } from '@app/common/database-tng/entities';
import { RpcPayload } from '@app/common/microservice-client';

@Controller()
export class DeliveryController {
  private readonly logger = new Logger(DeliveryController.name);
  private useCache: boolean

  constructor(
    configService: ConfigService,
    private readonly deliveryService: DeliveryService,
    private readonly prepareService: PrepareService
  ) {
    this.useCache = configService.get("USE_CACHE") === "true"
    this.logger.log("Use delivery cache: " + this.useCache)
  }
  

  @MessagePattern(DeliveryTopics.PREPARE_DELIVERY)
  async prepareDelivery(@RpcPayload() preDlv: PrepareDeliveryReqDto) {
    this.logger.log(`Prepare delivery for catalogId: ${preDlv.catalogId}`)
    if (this.useCache) {
      return this.prepareService.prepareDelivery(preDlv, async (dlv: DeliveryEntity) => {
        return await this.deliveryService.prepareDelivery(dlv.catalogId)
      });
    }
    const res = await this.deliveryService.prepareDeliveryV2(preDlv.catalogId);
    return res;

  }

  @MessagePattern(DeliveryTopics.PREPARED_DELIVERY_STATUS)
  async getPrepareDeliveryStatus(@RpcPayload("stringValue") catalogId: string) {
    this.logger.log(`Get prepared delivery status for catalogId: ${catalogId}`);
    if (this.useCache) {
      return this.prepareService.getPreparedDeliveryStatus(catalogId, async (dlv: DeliveryEntity) => await this.deliveryService.prepareDelivery(dlv.catalogId));
    }
    const res = await this.deliveryService.prepareDelivery(catalogId);
    return res;
  }

}
