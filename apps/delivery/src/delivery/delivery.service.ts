import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliveryStatusEntity, DeviceEntity, MapEntity, UploadVersionEntity, DeviceMapStateEntity, DeviceMapStateEnum, DeviceComponentStateEnum, DeliveryStatusEnum } from '@app/common/database/entities';
import { DeliveryStatusDto } from '@app/common/dto/delivery';
import { CacheConfigDto } from '@app/common/dto/delivery/dto/cache-config.dto';
import { ManagementService } from '../cache/management.service';
import { DeleteFromCacheDto } from '@app/common/dto/delivery/dto/delete-cache.dto';
import { MicroserviceClient, MicroserviceName } from '@app/common/microservice-client';
import { DeviceTopics, DeviceTopicsEmit } from '@app/common/microservice-client/topics';
import { DeviceSoftwareStateDto } from '@app/common/dto/device/dto/device-software.dto';
import { DeviceMapStateDto } from '@app/common/dto/device';

@Injectable()
export class DeliveryService {

  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly cacheMngService: ManagementService,
    @InjectRepository(UploadVersionEntity) private readonly uploadVersionRepo: Repository<UploadVersionEntity>,
    @InjectRepository(DeliveryStatusEntity) private readonly deliveryStatusRepo: Repository<DeliveryStatusEntity>,
    @InjectRepository(DeviceEntity) private readonly deviceRepo: Repository<DeviceEntity>,
    @InjectRepository(MapEntity) private readonly mapRepo: Repository<MapEntity>,
    @Inject(MicroserviceName.DISCOVERY_SERVICE) private readonly deviceClient: MicroserviceClient,
  ) { }

  async updateDownloadStatus(dlvStatus: DeliveryStatusDto) {
    const newStatus = this.deliveryStatusRepo.create(dlvStatus);

    let device = await this.deviceRepo.findOne({ where: { ID: dlvStatus.deviceId } })
    if (!device) {
      const newDevice = this.deviceRepo.create()
      newDevice.ID = dlvStatus.deviceId
      device = await this.deviceRepo.save(newDevice)
      this.logger.log(`A new device with Id - ${device.ID} has been registered`)
    }
    newStatus.device = device;

    const component = await this.uploadVersionRepo.findOneBy({ catalogId: dlvStatus.catalogId });
    if (component) {
      const isSaved =  await this.upsertDownloadStatus(newStatus);
      if (isSaved){
        this.logger.log("Send device software state");
        let state;
        if (dlvStatus.deliveryStatus === DeliveryStatusEnum.DELETED){
          state = DeviceComponentStateEnum.DELETED;
        }else {
          state = DeviceComponentStateEnum.DELIVERY;
        }
        let deviceState = new DeviceSoftwareStateDto();
        deviceState.state = state;
        deviceState.catalogId = dlvStatus.catalogId;
        deviceState.deviceId = dlvStatus.deviceId;
        this.deviceClient.emit(DeviceTopicsEmit.UPDATE_DEVICE_SOFTWARE_STATE, deviceState);
      }
      return isSaved;
    }

    const map = await this.mapRepo.findOneBy({ catalogId: dlvStatus.catalogId })
    if (map) {
      const isSaved = await this.upsertDownloadStatus(newStatus)

      if (isSaved) {
        this.logger.log("Send device map state");
        let state;
       if (dlvStatus.deliveryStatus === DeliveryStatusEnum.DELETED){
          state = DeviceMapStateEnum.DELETED;
        }else {
          state = DeviceMapStateEnum.DELIVERY;
        }
        let deviceState = new DeviceMapStateDto();
        deviceState.state = state;
        deviceState.catalogId = dlvStatus.catalogId;
        deviceState.deviceId = dlvStatus.deviceId;
        this.deviceClient.emit(DeviceTopicsEmit.UPDATE_DEVICE_MAP_STATE, deviceState);
      }
      return isSaved
    }
    this.logger.error(`Not found Item with this catalogId: ${dlvStatus.catalogId}`);
    throw new BadRequestException(`Not found Item with this catalogId: ${dlvStatus.catalogId}`);
  }

  private async upsertDownloadStatus(newStatus: DeliveryStatusEntity): Promise<Boolean> {
    let savedMap: any = await this.deliveryStatusRepo.createQueryBuilder()
      .insert()
      .values({ ...newStatus })
      .orIgnore()
      .execute()

    if (savedMap?.raw?.length == 0) {
      savedMap = await this.deliveryStatusRepo.createQueryBuilder()
        .update()
        .set({ ...newStatus })
        .where("deviceID = :deviceID", { deviceID: newStatus.device.ID })
        .andWhere("catalogId = :catalogId", { catalogId: newStatus.catalogId })
        .andWhere("item_key = :item_key", { item_key: newStatus.itemKey ?? "" })
        .andWhere("current_time < :current_time", { current_time: newStatus.currentTime })
        .execute()
    }

    return savedMap?.raw?.length > 0 || savedMap.affected > 0
  }

  // Delete
  deleteCacheItems(data: DeleteFromCacheDto) {
    if (data.size) {
      this.cacheMngService.deleteDeliveryBySize(data.size)
    }
    if (data.date) {
      this.cacheMngService.deleteDeliveryByDate(new Date(data.date))
    }
    if (data.catalogId) {
      this.cacheMngService.deleteDeliveryId(data.catalogId)
    }
  }

  // Config
  getDeliveryCacheConfigs() {
    return this.cacheMngService.getCacheConfigRes()
  }

  setDeliveryCacheConfigs(config: CacheConfigDto) {
    return this.cacheMngService.setCacheConfig(config)
  }
}
