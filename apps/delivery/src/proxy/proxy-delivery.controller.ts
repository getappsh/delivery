import { Controller, Logger } from '@nestjs/common';
import { DeliveryService } from './proxy-delivery.service';
import { ApiTags } from '@nestjs/swagger';
import { PrepareDeliveryReqDto } from '@app/common/dto/delivery';
import { MessagePattern} from '@nestjs/microservices';
import { DeliveryTopics } from '@app/common/microservice-client/topics';
import { PrepareService } from '../cache/prepare.service';
import { DeliveryEntity } from '@app/common/database-proxy/entities';
import { RpcPayload } from '@app/common/microservice-client';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

@ApiTags("Delivery")
@Controller('delivery')
export class DeliveryController {

  private readonly logger = new Logger(DeliveryController.name);

  constructor(
    private readonly deliveryService: DeliveryService,
    private readonly prepareService: PrepareService,
    @InjectRepository(DeliveryEntity) private readonly deliveryRepo: Repository<DeliveryEntity>,
  ) { }

  @MessagePattern(DeliveryTopics.PREPARE_DELIVERY)
  async prepareDelivery(@RpcPayload() preDlv: PrepareDeliveryReqDto) {
    this.logger.log(`Prepare delivery for catalogId: ${preDlv.catalogId}`)
    const res = await this.prepareService.prepareDelivery(preDlv, async (dlv: DeliveryEntity) => await this.deliveryService.getDeliveryResources(dlv));
    await this.deliveryService.applyOriginMetadata(res, preDlv.deviceId);
    return res;
  }

  @MessagePattern(DeliveryTopics.PREPARED_DELIVERY_STATUS)
  async getPrepareDeliveryStatus(@RpcPayload("stringValue") catalogId: string) {
    this.logger.log(`Get prepared delivery status for catalogId: ${catalogId}`);
    const res = await this.prepareService.getPreparedDeliveryStatus(catalogId, async (dlv: DeliveryEntity) => await this.deliveryService.getDeliveryResources(dlv));
    const dlv = await this.deliveryRepo.findOneBy({ catalogId });
    if (dlv?.deviceId) {
      await this.deliveryService.applyOriginMetadata(res, dlv.deviceId);
    }
    return res;
  }
}
