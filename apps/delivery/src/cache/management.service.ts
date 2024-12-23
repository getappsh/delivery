import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { S3Service } from '@app/common/AWS/s3.service';
import { InjectRepository } from '@nestjs/typeorm';
import { DeliveryEntity, DeliveryItemEntity } from '@app/common/database-tng/entities';
import { Brackets, In, LessThanOrEqual, Not, Repository } from 'typeorm';
import { CacheConfigEntity } from '@app/common/database-tng/entities/cache-config.entity';
import { CacheConfigDto } from '@app/common/dto/delivery/dto/cache-config.dto';
import { DeliveryStatusEnum, ItemTypeEnum, PrepareStatusEnum } from '@app/common/database/entities';
import { DeliveryError } from '@app/common/dto/delivery/dto/delivery-error';
import { ErrorCode } from '@app/common/dto/error';
import { CronExpression } from '@nestjs/schedule';
import { SafeCron } from '@app/common/safe-cron';
import { ConfigService } from '@nestjs/config';
import { _Object } from '@aws-sdk/client-s3';
import { HttpClientService } from './http-client.service';
import { DeliveryStatusDto } from '@app/common/dto/delivery';
import { CacheConfigResDto } from '@app/common/dto/delivery/dto/cache-config-get.dto';

@Injectable()
export class ManagementService implements OnApplicationBootstrap {

  private readonly logger = new Logger(ManagementService.name)
  CACHE_EXPIRATION_HOURS: number
  static CACHE_CLEAR_TIME_EXPRESSION = process.env.CACHE_CLEAR_TIME_EXPRESSION ?? CronExpression.EVERY_DAY_AT_MIDNIGHT
  static CACHE_SYNC_TIME_EXPRESSION = process.env.CACHE_SYNC_TIME_EXPRESSION ?? CronExpression.EVERY_DAY_AT_1AM

  constructor(
    private readonly env: ConfigService,
    private readonly S3Service: S3Service,
    private httpService: HttpClientService,
    @InjectRepository(DeliveryEntity) private readonly dlvRepo: Repository<DeliveryEntity>,
    @InjectRepository(DeliveryItemEntity) private readonly dlvItemRepo: Repository<DeliveryItemEntity>,
    @InjectRepository(CacheConfigEntity) private readonly cacheConfig: Repository<CacheConfigEntity>,
  ) {
    this.CACHE_EXPIRATION_HOURS = Number(this.env.get("CACHE_EXPIRATION_HOURS") || 24 * 7)
  }

  // Delete management
  async deleteDeliveryBySize(sizeToDelete: number, catalogId?: string) {
    try {
      this.logger.log(`Deletes entities to free up cache space with ${sizeToDelete} bytes`)
      const dlvIdsToDelete = await this.getDlvIdsBySize(sizeToDelete, catalogId)
      await this.deleteDeliveryEntity(dlvIdsToDelete)
    } catch (error) {
      const msg = `Error occurs in 'deleteDeliveryBySize' - ${error.toString()} `
      this.logger.error(msg)
      throw this.throwError(error, null, msg)
    }
  }

  async deleteDeliveryId(catalogId: string | string[]) {
    this.logger.log(`Deletes entities from the given catalog ids`)
    await this.deleteDeliveryEntity(catalogId)
  }

  async deleteDeliveryByDate(date: Date) {
    try {
      this.logger.log(`Deletes entities to free up cache space until ${date}`)
      const dlvIdsToDelete = await this.getDlvIdsByDate(date)
      await this.deleteDeliveryEntity(dlvIdsToDelete)
    } catch (error) {
      const msg = `Error occurs in 'deleteDeliveryByDate' - ${error.toString()} `
      this.logger.error(msg)
      throw this.throwError(error, null, msg)
    }
  }

  async getDlvIdsBySize(size: number, catalogId?: string): Promise<string[]> {
    this.logger.debug(`Get dlv entities by size of: ${size} bytes`)
    let dlvIds: string[] = []
    let sumDlvSize = 0
    let skip = 0
    const maxSkip = await this.dlvRepo.count({ where: [{ status: PrepareStatusEnum.DONE }, { status: PrepareStatusEnum.ERROR }] })

    const getDlvSizes = async (skip: number) => {
      let sumSize = 0
      const id = catalogId ?? "catalogId"

      const query = this.dlvRepo.createQueryBuilder("delivery")
        .select(["delivery.catalogId", "delivery.size"])
        .orderBy("delivery.createdDate", "ASC")
        .where("delivery.status = :done", { done: PrepareStatusEnum.DONE })
        // .orWhere("delivery.status = :error AND delivery.err_code = :errorCode", { error: PrepareStatusEnum.DELETE, errorCode: ErrorCode.DLV_NOT_EXIST })
        .orWhere(
          new Brackets(qb => {
            qb.where("delivery.status = :error", { error: PrepareStatusEnum.ERROR })
              .andWhere("delivery.err_code = :errorCode", { errorCode: ErrorCode.DLV_C_NOT_VERIFIED });
          })
        )
        .andWhere("delivery.catalogId != :id", { id })
        .take(1)
        .skip(skip)

      const dlvSizes = await query.getMany()
      this.logger.verbose(`dlv entity size ${JSON.stringify(dlvSizes)}`)

      for (let i = 0; i < dlvSizes.length; i++) {
        let dlv = dlvSizes[i];
        sumSize = sumSize + dlv.size;

        dlvIds.push(dlv.catalogId);
        if (sumSize >= size) {
          break;
        }
      }

      return sumSize
    }

    do {
      sumDlvSize = sumDlvSize + await getDlvSizes(skip)
      skip = skip + 1
    } while (sumDlvSize < size && skip <= maxSkip);

    this.logger.debug(`select ${dlvIds.length} dlv entities with sum of size: ${sumDlvSize}`)
    return dlvIds
  }

  async getDlvIdsByDate(date: Date): Promise<string[]> {
    this.logger.debug(`Get dlv entities until date: ${date}`)
    const dlv = await this.dlvRepo.find({
      where: { createdDate: LessThanOrEqual(date) },
      select: ["catalogId"]
    })
    return dlv.map(d => d.catalogId)
  }

  async deleteDeliveryEntity(dlvId: string | string[]) {
    const dlvIds = Array.isArray(dlvId) ? dlvId : [dlvId]
    try {
      const dlvs = await this.getDeliveryWithItems(dlvIds)
      await Promise.all(dlvs.map(async dlv => {
        this.logger.debug(`Delete delivery entity ${dlv.catalogId}`)
        await Promise.all(dlv.items.map(async item => {
          // TODO - handel when the file is a docker image
          await this.S3Service.deleteFile(item.path)
          await this.dlvItemRepo.update({ id: item.id }, { status: PrepareStatusEnum.DELETE })

          if (this.env.get("IS_PROXY") === "true") {
            const dlvStatus = new DeliveryStatusDto()
            dlvStatus.catalogId = dlv.catalogId
            dlvStatus.deviceId = 'TNG' // todo
            dlvStatus.itemKey = item.itemKey
            dlvStatus.deliveryStatus = DeliveryStatusEnum.DELETED
            dlvStatus.type = ItemTypeEnum.CACHE
            this.httpService.apiUpdateDeliveryStatus(dlvStatus).catch(err => this.logger.error(`Failed to update dlv status, ${err}`));
          }
        }))

        await this.dlvRepo.update({ catalogId: dlv.catalogId }, { status: PrepareStatusEnum.DELETE })
      }))
    } catch (err) {
      const errMsg = `Error when deleting delivery entities - ${err}`
      this.logger.error(errMsg)
      throw new DeliveryError(ErrorCode.DLV_C_CLEAR_ISSUE, errMsg)
    }
  }

  async clearInventoryByDeliveryDone() {
    this.logger.log("Clear 'cache inventory' by - delivery Done");
    const dateToDelete = new Date().setHours(0, 0, 0, 0) - (this.CACHE_EXPIRATION_HOURS * 60 * 60 * 1000)

    const DEsToDelete = await this.dlvRepo.find({
      select: { catalogId: true },
      where: {
        status: PrepareStatusEnum.DONE,
        lastUpdatedDate: LessThanOrEqual(new Date(dateToDelete))
      }
    })
    const idsToDelete = DEsToDelete.map(de => de.catalogId)

    if (idsToDelete.length) {
      this.logger.debug(`Expired device entities to delete: ${idsToDelete}`)
      await this.deleteDeliveryEntity(idsToDelete)
    }
  }

  async clearInventoryByDeliveryError() {
    this.logger.log("Clear 'cache inventory' by - delivery Error");

    const DEsToDelete = await this.dlvRepo.find({
      select: { catalogId: true },
      where: { status: PrepareStatusEnum.ERROR }
    })
    const idsToDelete = DEsToDelete.map(de => de.catalogId)

    if (idsToDelete.length) {
      this.logger.debug(`Error device entities to delete: ${idsToDelete}`)
      await this.deleteDeliveryEntity(idsToDelete)
    }
  }

  @SafeCron({ name: "Clear delivered map inventory", cronTime: ManagementService.CACHE_CLEAR_TIME_EXPRESSION })
  async clearDeliveredMapInventory() {
    try {
      await this.clearInventoryByDeliveryDone()
      await this.clearInventoryByDeliveryError()
    } catch (error) {
      this.logger.error(`Error occurs in 'Clear delivered map inventory' job - ${error.toString()} `)
    }
  }

  // Space management
  @SafeCron({ name: "sync delivery consistency DB to S3", cronTime: ManagementService.CACHE_SYNC_TIME_EXPRESSION })
  async syncDeliveryConsistencyDBtoS3() {
    this.logger.log(`Start verifying S3 artifacts against the DB`);

    try {
      // Initialize a map of delivery items by their path for quick lookup
      const deliveryItems: { [path: string]: DeliveryItemEntity } = {};
      (await this.dlvItemRepo.find({
        select: {
          id: true,
          size: true,
          path: true,
          status: true,
          delivery: { catalogId: true },
        },
        relations: { delivery: true },
      })).forEach((item: DeliveryItemEntity) => {
        if (item.metaData == "docker_image"){
            // TODO - when item is docker images sync with the docker registry
            return
        }else {
          deliveryItems[item.path] = item;
        }
      });

      // Fetch S3 bucket contents and prepare lists for missing and verified items
      const s3List = (await this.S3Service.getBucketObjList()).Contents.filter(i => i.Key.startsWith("cache"));      
      const missingInDatabase: string[] = [];
      const verifiedObjects: { [key: string]: _Object } = {};
      const invalidItemsInDB: DeliveryItemEntity[] = [];

      // Check each object in S3 against the database records    
      s3List?.forEach((s3Object) => {
        if (!deliveryItems[s3Object.Key] || deliveryItems[s3Object.Key].status == PrepareStatusEnum.DELETE) {
          missingInDatabase.push(s3Object.Key);
        } else {
          verifiedObjects[s3Object.Key] = s3Object;
        }
      });

      // Check each database item against verified S3 objects
      Object.values(deliveryItems).forEach((item) => {
        if (!verifiedObjects[item.path] && (item.status != PrepareStatusEnum.DELETE && item.status != PrepareStatusEnum.ERROR)) {
          invalidItemsInDB.push(item);
        }
      });

      this.logger.debug(`DeliveryItemsCount: ${Object.keys(deliveryItems).length}, verifiedS3ObjectsCount: ${Object.keys(verifiedObjects).length}, invalidItemsInDBCount: ${invalidItemsInDB.length}`);
      this.logger.debug(`missingInDatabaseCount: ${missingInDatabase.length}`);

      // Remove any S3 objects not found in the database
      if (missingInDatabase.length) {
        this.logger.log(`Removing ${missingInDatabase.length} orphaned S3 objects...`);
        missingInDatabase.forEach(async (objectKey) => {
          await this.S3Service.deleteFile(objectKey);
        });
      }

      // Update the database items that are missing in S3
      const invalidItemToUpdate = invalidItemsInDB.filter(i => i.status != PrepareStatusEnum.ERROR).map((item) => item.id)
      if (invalidItemToUpdate.length) {
        const updateFields = {
          status: PrepareStatusEnum.ERROR,
          errCode: ErrorCode.DLV_C_NOT_EXIST,
          errMsg: "Package not found in S3",
        };
        // Log the invalid items update
        this.logger.log(`Updating ${invalidItemsInDB.length} invalid items in DB...`);
        await this.dlvItemRepo.update(
          { id: In(invalidItemToUpdate) },
          updateFields
        );

        // Update related delivery records as well
        await this.dlvRepo.update(
          { catalogId: In(invalidItemsInDB.map((item) => item.delivery.catalogId)) },
          updateFields
        );
      }
    } catch (error) {
      this.logger.error(`Error occurs in 'sync delivery consistency DB to S3' job - ${error.toString()} `)
    }
    this.logger.log("Sync process complete.");
  }

  async getUsedCacheSize(catalogId?: string): Promise<number> {
    const usedSize = await this.dlvRepo.createQueryBuilder("delivery")
      .select("SUM(delivery.size)", "sum")
      .where("delivery.catalogId != :catalogId", { catalogId: catalogId ?? "catalogId" })
      .andWhere("delivery.status = :status", { status: PrepareStatusEnum.DONE })
      .orWhere(
        new Brackets(qb => {
          qb.where("delivery.status = :error", { error: PrepareStatusEnum.ERROR })
            .andWhere("delivery.err_code = :errorCode", { errorCode: ErrorCode.DLV_C_NOT_VERIFIED });
        })
      )
      .getRawOne();

    this.logger.log(`cache in use: ${(usedSize.sum / (1024 * 1024 * 1024)).toFixed(2)}GB`)
    return usedSize.sum
  }

  async getCacheSpaceInfo(catalogId?: string): Promise<{ free: number, used: number }> {
    const usedSize = await this.getUsedCacheSize(catalogId)
    const maxCapacity = (await this.getCacheConfig()).maxCapacityInGB * (1024 ** 3)
    const freeSpace = maxCapacity - usedSize
    const freesSpaceInPercentage = freeSpace / maxCapacity * 100

    if (freesSpaceInPercentage < 10) {
      this.logger.warn(`Free cache capacity is ${freesSpaceInPercentage.toFixed(2)}% full`)
    } else {
      this.logger.log(`Free cache capacity is ${freesSpaceInPercentage.toFixed(2)}% full`)
    }
    return { used: usedSize, free: freeSpace }
  }

  async isEnableCachingDelivery(dlvSize: number, catalogId: string): Promise<boolean> {
    this.logger.log(`Checking capacity of cache`)
    const freeSpace = (await this.getCacheSpaceInfo(catalogId)).free

    if (freeSpace >= dlvSize) {
      this.logger.debug(`Enough space in cache to download delivery`)
      return true
    }

    this.logger.warn(`Not enough space in cache to download delivery`)
    // this.sendNotification()
    return false

  }

  // Configs management
  async getCacheConfig() {
    const configs = await this.getCacheConfigFromRepo()
    if (!configs) {
      this.logger.warn(`There is not exist cache configuration`)
    }
    const configRes = CacheConfigDto.fromCacheConfigEntity(configs)
    return configRes
  }

  async getCacheConfigRes() {
    const configRes = await this.getCacheConfig() as CacheConfigResDto
    const cacheInfo = await this.getCacheSpaceInfo();
    configRes.usedCapacityGB = Number((cacheInfo.used / (1024 ** 3)).toFixed(2));
    configRes.freeCapacityGB = Number((cacheInfo.free / (1024 ** 3)).toFixed(2));    
    return configRes
  }

  async setCacheConfig(config: CacheConfigDto): Promise<CacheConfigDto> {
    const resMsg: string[] = []
    if (config.maxCapacityInGB) {
      const cacheUsed = (await this.getCacheSpaceInfo()).used
      const maxInBytes = config.maxCapacityInGB * (1024 ** 3)
      if (cacheUsed > maxInBytes) {
        resMsg.push("Error setting 'usedCapacityGB': the current cache usage exceeds the new limit you are trying to set.");
        delete config.maxCapacityInGB
      }
    }
    const resConfig = await this.setCacheConfigInRepo(config) as CacheConfigResDto
    if (resMsg.length) {
      resConfig.mes = resMsg
    }
    return resConfig
  }

  async setDefaultConfig() {
    const eCong = await this.getCacheConfigFromRepo()

    const defaults = new CacheConfigDto()
    defaults.maxCapacityInGB = 1000

    let defaultsToSave: CacheConfigDto
    if (eCong && eCong.configs) {
      defaultsToSave = Object.assign(new CacheConfigDto(), defaults, JSON.parse(eCong?.configs))
    } else {
      defaultsToSave = defaults
    }

    try {
      this.logger.log(`sets defaults configuration for cache`)
      await this.setCacheConfigInRepo(defaultsToSave)
    } catch (error) {
      this.logger.error(error)
    }
  }

  async getCacheConfigFromRepo() {
    const configs = await this.cacheConfig.find({ order: { lastUpdatedDate: "DESC" } })
    return configs.length > 0 ? configs[0] : null
  }

  async setCacheConfigInRepo(config: CacheConfigDto): Promise<CacheConfigDto> {
    // eConfig === exits config
    this.logger.debug(`Find exist config and update it or create it`)
    let eConfig = await this.getCacheConfigFromRepo()

    if (!eConfig) {
      eConfig = this.cacheConfig.create()
      eConfig.configs = config.toString()
    } else {
      eConfig.configs = JSON.stringify({ ...JSON.parse(eConfig.configs), ...config })
    }
    eConfig = await this.cacheConfig.save(eConfig)
    return CacheConfigDto.fromCacheConfigEntity(eConfig)
  }

  // Utils
  throwError(error: any, errorCode?: ErrorCode, errMsg?: string) {
    if (error instanceof DeliveryError) {
      throw error
    } else {
      const err = new DeliveryError(errorCode || ErrorCode.DLV_OTHER, errMsg || error.toString())
      throw err
    }

  }

  async getDeliveryWithItems(dlvIds: string[]): Promise<DeliveryEntity[]> {
    return await this.dlvRepo.find({ where: { catalogId: In(dlvIds) }, relations: { items: true } })
  }

  onApplicationBootstrap() {
    this.setDefaultConfig()
  }

}
