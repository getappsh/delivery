import { DeliveryTopics, DeliveryTopicsEmit } from '@app/common/microservice-client/topics';
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, EventPattern } from '@nestjs/microservices';
import { DeliveryStatusDto } from '@app/common/dto/delivery';
import { ConfigService } from '@nestjs/config';
import { DeliveryService } from './delivery.service';
import { CacheConfigDto } from '@app/common/dto/delivery/dto/cache-config.dto';
import { DeleteFromCacheDto } from '@app/common/dto/delivery/dto/delete-cache.dto';
import { RpcPayload } from '@app/common/microservice-client';
import * as fs from 'fs';
import { CacheConfigResDto } from '@app/common/dto/delivery/dto/cache-config-get.dto';

@Controller()
export class DeliveryController {
  private readonly logger = new Logger(DeliveryController.name);
  private useCache: boolean

  constructor(
    configService: ConfigService,
    private readonly deliveryService: DeliveryService,
  ) {
    this.useCache = configService.get("USE_CACHE") === "true"
  }

  @EventPattern(DeliveryTopicsEmit.UPDATE_DOWNLOAD_STATUS)
  updateDownloadStatus(@RpcPayload() data: DeliveryStatusDto) {
    this.logger.log(`Update delivery status from device: "${data['deviceId']}" for catalog id: "${data['catalogId']}"`)
    this.deliveryService.updateDownloadStatus(data).catch(e => {
      this.logger.error(`Error update delivery status: ${e.message}`)
    });
  }

  // #####################Cache managing##############################

  // Delete
  @EventPattern(DeliveryTopicsEmit.DELETE_CACHE_ITEMS)
  deleteCacheItems(@RpcPayload() data: DeleteFromCacheDto) {
    this.deliveryService.deleteCacheItems(data)
  }

  // Config
  @MessagePattern(DeliveryTopics.GET_CACHE_CONFIG)
  getDeliveryCacheConfigs(): Promise<CacheConfigDto> | CacheConfigDto {
    this.logger.log(`Get Delivery cache config`)
    if (this.useCache) {
      return this.deliveryService.getDeliveryCacheConfigs()
    }
    return CacheConfigResDto.fromMsg(`Cache feature not in use`)
  }

  @MessagePattern(DeliveryTopics.SET_CACHE_CONFIG)
  setDeliveryCacheConfigs(@RpcPayload() config: CacheConfigDto): Promise<CacheConfigDto> | CacheConfigDto {
    this.logger.log(`Get Delivery cache config`)
    if (this.useCache) {
      return this.deliveryService.setDeliveryCacheConfigs(config)
    }
    return CacheConfigResDto.fromMsg(`Cache feature not in use`)
  }

  @MessagePattern(DeliveryTopics.CHECK_HEALTH)
  checkHealth() {
    const version = this.readImageVersion()
    this.logger.log(`Delivery service - Health checking, Version: ${version}`)
    return "Delivery service is success, Version: " + version
  }

  private readImageVersion(){
    let version = 'unknown'
    try{
      version = fs.readFileSync('NEW_TAG.txt','utf8');
    }catch(error){
      this.logger.error(`Unable to read image version - error: ${error}`)
    }
    return version
  }
}
