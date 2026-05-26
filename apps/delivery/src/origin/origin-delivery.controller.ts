import { DeliveryTopics } from '@app/common/microservice-client/topics';
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, EventPattern } from '@nestjs/microservices';
import { DeliveryService } from './origin-delivery.service';
import { PrepareDeliveryReqDto } from '@app/common/dto/delivery';
import { ConfigService } from '@nestjs/config';
import { PrepareService } from '../cache/prepare.service';
import { DeliveryEntity } from '@app/common/database-proxy/entities';
import { RpcPayload } from '@app/common/microservice-client';
import { AgentCompatibilityService } from '../cache/agent-compatibility.service';

@Controller()
export class DeliveryController {
  private readonly logger = new Logger(DeliveryController.name);
  private useCache: boolean

  constructor(
    configService: ConfigService,
    private readonly deliveryService: DeliveryService,
    private readonly prepareService: PrepareService,
    private readonly agentCompatibility: AgentCompatibilityService,
  ) {
    this.useCache = configService.get("USE_CACHE") === "true"
    this.logger.log("Use delivery cache: " + this.useCache)
  }
  

  @MessagePattern(DeliveryTopics.PREPARE_DELIVERY)
  async prepareDelivery(@RpcPayload() preDlv: PrepareDeliveryReqDto) {
    this.logger.log(`Prepare delivery for catalogId: ${preDlv.catalogId}`)
    let res;
    if (this.useCache) {
      res = await this.prepareService.prepareDelivery(preDlv, async (dlv: DeliveryEntity) => {
        return await this.deliveryService.prepareDeliveryV2(dlv.catalogId)
      });
    } else {
      res = await this.deliveryService.prepareDeliveryV2(preDlv.catalogId);
    }
    await this.agentCompatibility.applyCompatibility(res, preDlv.deviceId);
    return res;
  }

  @MessagePattern(DeliveryTopics.PREPARED_DELIVERY_STATUS)
  async getPrepareDeliveryStatus(@RpcPayload("stringValue") catalogId: string) {
    this.logger.log(`Get prepared delivery status for catalogId: ${catalogId}`);
    let res;
    if (this.useCache) {
      res = await this.prepareService.getPreparedDeliveryStatus(catalogId, async (dlv: DeliveryEntity) => await this.deliveryService.prepareDeliveryV2(dlv.catalogId));
    } else {
      res = await this.deliveryService.prepareDeliveryV2(catalogId);
    }
    return res;
  }

}
