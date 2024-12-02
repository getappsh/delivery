import { Body, Controller, Get, Logger, NotFoundException, Param, Post } from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { PrepareDeliveryResDto, PrepareDeliveryReqDto } from '@app/common/dto/delivery';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { DeliveryTopics } from '@app/common/microservice-client/topics';

@ApiTags("Delivery")
// @ApiBearerAuth()
@Controller('delivery')
export class DeliveryController {

  private readonly logger = new Logger(DeliveryController.name);

  constructor(
    private readonly deliveryService: DeliveryService,
  ) { }

  @MessagePattern(DeliveryTopics.PREPARE_DELIVERY)
  prepareDelivery(preDlv: PrepareDeliveryReqDto) {
    this.logger.debug(`Prepare delivery for catalogId: ${preDlv.catalogId}`)
    return this.deliveryService.prepareDelivery(preDlv);
  }

  @MessagePattern(DeliveryTopics.PREPARED_DELIVERY_STATUS)
  getPrepareDeliveryStatus(@Payload("stringValue") catalogId: string) {
    this.logger.log(`Get prepared delivery status for catalogId: ${catalogId}`);
    return this.deliveryService.getPreparedDeliveryStatus(catalogId);
  }
}
