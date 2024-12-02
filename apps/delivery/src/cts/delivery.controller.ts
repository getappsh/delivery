import { DeliveryTopics, DeliveryTopicsEmit, UploadTopics } from '@app/common/microservice-client/topics';
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, EventPattern, Payload } from '@nestjs/microservices';
import { DeliveryService } from './delivery.service';
import { DeliveryStatusDto, PrepareDeliveryReqDto } from '@app/common/dto/delivery';
import { PrepareService } from './prepare.service';
import { ConfigService } from '@nestjs/config';

@Controller()
export class DeliveryController {
  private readonly logger = new Logger(DeliveryController.name);
  private useCache: boolean

  constructor(
    configService: ConfigService,
    private readonly deliveryService: DeliveryService,
    private readonly prepareService: PrepareService
    ) {
      this.useCache = configService.get<boolean>("USE_MAP_CACHE")  || false
      this.logger.log("Use delivery cache: " + this.useCache)
     }

  @EventPattern(DeliveryTopicsEmit.UPDATE_DOWNLOAD_STATUS)
  updateDownloadStatus(data: DeliveryStatusDto) {
    this.logger.log(`Update delivery status from device: "${data['deviceId']}" for catalog id: "${data['catalogId']}"`)
    this.deliveryService.updateDownloadStatus(data).catch(e => {
      this.logger.error(`Error update delivery status: ${e.message}`)
    });
  }

  @MessagePattern(DeliveryTopics.PREPARE_DELIVERY)
  async prepareDelivery(preDlv: PrepareDeliveryReqDto){
    this.logger.log(`Prepare delivery for catalogId: ${preDlv.catalogId}`)
    const res = await this.deliveryService.prepareDelivery(preDlv);
    if (this.useCache) {
      return this.prepareService.prepareDelivery(preDlv, res.url);
    }
    return res;
    
  }

  @MessagePattern(DeliveryTopics.PREPARED_DELIVERY_STATUS)
  async getPrepareDeliveryStatus(@Payload("stringValue") catalogId: string){
    this.logger.log(`Get prepared delivery status for catalogId: ${catalogId}`);
    const res = await this.deliveryService.getPrepareDeliveryStatus(catalogId);
    if (this.useCache) {
      return this.prepareService.getPreparedDeliveryStatus(catalogId, res.url);
    }
    return res;
  }

  @MessagePattern(DeliveryTopics.CHECK_HEALTH)
  healthCheckSuccess(){
    return "Delivery service is success"
  }
}
