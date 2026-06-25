import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliveryStatusEntity, DeviceEntity, MapEntity, DeviceMapStateEnum, DeviceComponentStateEnum, DeliveryStatusEnum, DeliveryStateEnum, ReleaseEntity } from '@app/common/database/entities';
import { DeliveryStatusDto } from '@app/common/dto/delivery';
import { CacheConfigDto } from '@app/common/dto/delivery/dto/cache-config.dto';
import { ManagementService } from '../cache/management.service';
import { DeleteFromCacheDto } from '@app/common/dto/delivery/dto/delete-cache.dto';
import { MicroserviceClient, MicroserviceName } from '@app/common/microservice-client';
import { AlertTopicsEmit, DeviceTopicsEmit } from '@app/common/microservice-client/topics';
import { DeviceComponentStateDto } from '@app/common/dto/device/dto/device-software.dto';
import { DeviceMapStateDto } from '@app/common/dto/device';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class DeliveryService {

  private readonly logger = new Logger(DeliveryService.name);
  // TEMPORARY: GetMap HTTP client for forwarding download status updates.
  // TODO: Remove once GetMap is fully integrated — delivery will ask
  // get-map microservice directly via Kafka topic.
  private getmapClient: AxiosInstance | null = null;

  constructor(
    private readonly cacheMngService: ManagementService,
    @InjectRepository(ReleaseEntity) private readonly releaseRepo: Repository<ReleaseEntity>,
    @InjectRepository(DeliveryStatusEntity) private readonly deliveryStatusRepo: Repository<DeliveryStatusEntity>,
    @InjectRepository(DeviceEntity) private readonly deviceRepo: Repository<DeviceEntity>,
    @InjectRepository(MapEntity) private readonly mapRepo: Repository<MapEntity>,
    @Inject(MicroserviceName.DISCOVERY_SERVICE) private readonly deviceClient: MicroserviceClient,
    @Inject(MicroserviceName.PROJECT_MANAGEMENT_SERVICE) private readonly projectManagementClient: MicroserviceClient,
    @Inject(MicroserviceName.DEPLOY_SERVICE) private readonly deployClient: MicroserviceClient,
    configService: ConfigService,
  ) {
    const getmapServerUrl = configService.get<string>("GETMAP_SERVER_URL");
    if (getmapServerUrl) {
      const deviceSecret = configService.get<string>("DEVICE_SECRET");
      this.getmapClient = axios.create({
        baseURL: getmapServerUrl.replace(/\/+$/, ''),
        timeout: 10000,
        headers: deviceSecret ? { "device-auth": deviceSecret } : {},
      });
    }
  }

  async updateDownloadStatus(dlvStatus: DeliveryStatusDto) {
    const newStatus = this.deliveryStatusRepo.create(dlvStatus);
    newStatus.progress = dlvStatus.downloadData
    newStatus.state = dlvStatus.state;

    let device = await this.deviceRepo.findOne({ where: { ID: dlvStatus.deviceId } })
    if (!device) {
      const newDevice = this.deviceRepo.create()
      newDevice.ID = dlvStatus.deviceId
      device = await this.deviceRepo.save(newDevice)
      this.logger.log(`A new device with Id - ${device.ID} has been registered`)
    }
    newStatus.device = device;

    // Emit alerts for delivery lifecycle events
    this.emitDeliveryAlert(dlvStatus);

    const release = await this.releaseRepo.findOneBy({ catalogId: dlvStatus.catalogId });
    if (release) {
      const isSaved = await this.upsertDownloadStatus(newStatus);
      this.logger.debug(`Is saved: ${isSaved}`);
      if (isSaved) {
        this.logger.log("Send device software state");

        let deviceState = new DeviceComponentStateDto();
        deviceState.catalogId = dlvStatus.catalogId;
        deviceState.deviceId = dlvStatus.deviceId;
        deviceState.downloadedAt = dlvStatus.downloadDone ?? dlvStatus.downloadStart

        if (dlvStatus.deliveryStatus === DeliveryStatusEnum.DELETED) {
          deviceState.state = DeviceComponentStateEnum.DELETED;
        } else if (dlvStatus.deliveryStatus === DeliveryStatusEnum.ERROR) {
          deviceState.state = DeviceComponentStateEnum.DELIVERY;
          deviceState.error = "Error"
        } else if (dlvStatus.deliveryStatus === DeliveryStatusEnum.DONE
          && (!dlvStatus.state || dlvStatus.state === DeliveryStateEnum.DONE)) {
          // Only mark as DOWNLOADED when the entire delivery is complete (state == Done or absent for backward compat)
          deviceState.state = DeviceComponentStateEnum.DOWNLOADED;
        } else {
          deviceState.state = DeviceComponentStateEnum.DELIVERY;
        }


        this.deviceClient.emit(DeviceTopicsEmit.UPDATE_DEVICE_SOFTWARE_STATE, deviceState);
      }
      return isSaved;
    }

    const map = await this.mapRepo.findOneBy({ catalogId: dlvStatus.catalogId })
    if (map) {
      const isSaved = await this.upsertDownloadStatus(newStatus)

      if (isSaved) {
        this.logger.log("Send device map state");

        let deviceState = new DeviceMapStateDto();
        deviceState.catalogId = dlvStatus.catalogId;
        deviceState.deviceId = dlvStatus.deviceId;
        deviceState.downloadedAt = dlvStatus.downloadDone ?? dlvStatus.downloadStart

        if (dlvStatus.deliveryStatus === DeliveryStatusEnum.DELETED) {
          deviceState.state = DeviceMapStateEnum.DELETED;
        } else if (dlvStatus.deliveryStatus === DeliveryStatusEnum.ERROR) {
          deviceState.state = DeviceMapStateEnum.DELIVERY;
          deviceState.error = "Error"
        } else {
          deviceState.state = DeviceMapStateEnum.DELIVERY;
        }

        this.deviceClient.emit(DeviceTopicsEmit.UPDATE_DEVICE_MAP_STATE, deviceState);
      }
      return isSaved
    }
    // TEMPORARY SOLUTION — GetMap proxy delivery status tracking
    // When maps are delivered via GetMap server proxy (GETMAP_SERVER_URL),
    // the catalogId exists only on the remote GetMap server's DB.
    // Forward the status update to GetMap server so they can track it.
    //
    // TODO: When merging GetMap into GetApp (removing the proxy):
    // 1. Revert this to throw BadRequestException (original behavior)
    // 2. Remove the GETMAP_SERVER_URL proxy flow entirely
    // 3. All catalogIds will exist locally — no need for this workaround
    if (this.getmapClient) {
      this.logger.log(`CatalogId not found locally, forwarding status update to GetMap server: ${dlvStatus.catalogId}`);
      try {
        await this.getmapClient.post('/api/v1/delivery/updateDownloadStatus', dlvStatus);
        return true;
      } catch (error: any) {
        this.logger.warn(`Failed to forward status update to GetMap server: ${error.message}`);
        return true;
      }
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

  // Get delivery statuses for a specific catalog
  async getDeliveryStatuses(catalogId: string): Promise<DeliveryStatusEntity[]> {
    this.logger.log(`Getting delivery statuses for catalogId: ${catalogId}`);
    try {
      const statuses = await this.deliveryStatusRepo.find({
        where: { catalogId },
        relations: ['device']
      });
      this.logger.debug(`Found ${statuses.length} delivery statuses for catalogId: ${catalogId}`);
      return statuses;
    } catch (error: any) {
      this.logger.error(`Error getting delivery statuses for catalogId: ${catalogId}, error: ${error.message}`);
      throw error;
    }
  }

  async getThroughputMetrics(range: string): Promise<{ dataPoints: Array<{ timestamp: string; mbPerMin: number }> }> {
    this.logger.log(`Getting throughput metrics for range: ${range}`);
    const hours = this.parseRangeToHours(range);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const result = await this.deliveryStatusRepo
      .createQueryBuilder('ds')
      .select(`date_trunc('minute', ds.download_done)`, 'bucket')
      .addSelect('COALESCE(SUM(ds.bit_number) / 1048576.0, 0)', 'mbPerMin')
      .where('ds.download_done >= :since', { since })
      .andWhere('ds.delivery_status = :status', { status: DeliveryStatusEnum.DONE })
      .groupBy(`date_trunc('minute', ds.download_done)`)
      .orderBy('bucket', 'ASC')
      .getRawMany();

    return {
      dataPoints: result.map(row => ({
        timestamp: row.bucket,
        mbPerMin: parseFloat(row.mbPerMin) || 0,
      })),
    };
  }

  private parseRangeToHours(range: string): number {
    const match = range.match(/^(\d+)(h|d)$/);
    if (!match) return 24;
    const value = parseInt(match[1], 10);
    return match[2] === 'd' ? value * 24 : value;
  }

  private emitDeliveryAlert(dlvStatus: DeliveryStatusDto): void {
    if (dlvStatus.deliveryStatus === DeliveryStatusEnum.START) {
      this.deployClient.emit(AlertTopicsEmit.SYSTEM_ALERT, {
        type: 'delivery_started',
        severity: 'info',
        message: `Device ${dlvStatus.deviceId} started downloading component ${dlvStatus.catalogId}`,
        deviceId: dlvStatus.deviceId,
        catalogId: dlvStatus.catalogId,
        source: 'delivery',
      });
    } else if (dlvStatus.deliveryStatus === DeliveryStatusEnum.DONE) {
      this.deployClient.emit(AlertTopicsEmit.SYSTEM_ALERT, {
        type: 'delivery_completed',
        severity: 'info',
        message: `Device ${dlvStatus.deviceId} completed downloading component ${dlvStatus.catalogId}`,
        deviceId: dlvStatus.deviceId,
        catalogId: dlvStatus.catalogId,
        source: 'delivery',
      });
    } else if (dlvStatus.deliveryStatus === DeliveryStatusEnum.ERROR) {
      this.deployClient.emit(AlertTopicsEmit.SYSTEM_ALERT, {
        type: 'delivery_error',
        severity: 'critical',
        message: `Device ${dlvStatus.deviceId} encountered an error downloading component ${dlvStatus.catalogId}`,
        deviceId: dlvStatus.deviceId,
        catalogId: dlvStatus.catalogId,
        source: 'delivery',
      });
    }
  }
}
