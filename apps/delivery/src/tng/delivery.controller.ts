import { Controller, Logger } from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import { ApiTags } from '@nestjs/swagger';
import { PrepareDeliveryReqDto } from '@app/common/dto/delivery';
import { MessagePattern} from '@nestjs/microservices';
import { DeliveryTopics } from '@app/common/microservice-client/topics';
import { PrepareService } from '../cache/prepare.service';
import { DeliveryEntity } from '@app/common/database-tng/entities';
import { RpcPayload } from '@app/common/microservice-client';

@ApiTags("Delivery")
@Controller('delivery')
export class DeliveryController {

  private readonly logger = new Logger(DeliveryController.name);

  constructor(
    private readonly deliveryService: DeliveryService,
    private readonly prepareService: PrepareService,
  ) { }

  @MessagePattern(DeliveryTopics.PREPARE_DELIVERY)
  prepareDelivery(@RpcPayload() preDlv: PrepareDeliveryReqDto) {
    this.logger.log(`Prepare delivery for catalogId: ${preDlv.catalogId}`)
    return this.prepareService.prepareDelivery(preDlv, async (dlv: DeliveryEntity) => await this.deliveryService.getDeliveryResources(dlv));
  }

  @MessagePattern(DeliveryTopics.PREPARED_DELIVERY_STATUS)
  getPrepareDeliveryStatus(@RpcPayload("stringValue") catalogId: string) {
    this.logger.log(`Get prepared delivery status for catalogId: ${catalogId}`);
    return this.prepareService.getPreparedDeliveryStatus(catalogId, async (dlv: DeliveryEntity) => await this.deliveryService.getDeliveryResources(dlv));
  }
}
