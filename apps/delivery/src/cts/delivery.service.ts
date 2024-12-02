import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliveryStatusEntity, ItemTypeEnum, DeviceEntity, DiscoveryMessageEntity, MapEntity, MapImportStatusEnum, PackageStatus, UploadStatus, UploadVersionEntity, VersionPackagesEntity, DeviceMapStateEntity, DeviceMapStateEnum, PrepareStatusEnum } from '@app/common/database/entities';
import { ArtifactoryService } from '@app/common/artifactory';
import { createWriteStream, existsSync, mkdirSync } from "fs"
import { PackageMessageDto, DeliveryStatusDto, PrepareDeliveryReqDto, PrepareDeliveryResDto } from '@app/common/dto/delivery';
import { S3Service } from '@app/common/AWS/s3.service';

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);
  packageInPreparation: VersionPackagesEntity | null;

  constructor(
    // private readonly artifactory: ArtifactoryService,
    private s3Service: S3Service,
    @InjectRepository(UploadVersionEntity) private readonly uploadVersionRepo: Repository<UploadVersionEntity>,
    @InjectRepository(DeliveryStatusEntity) private readonly deliveryStatusRepo: Repository<DeliveryStatusEntity>,
    @InjectRepository(DeviceEntity) private readonly deviceRepo: Repository<DeviceEntity>,
    @InjectRepository(MapEntity) private readonly mapRepo: Repository<MapEntity>,
    @InjectRepository(DeviceMapStateEntity) private readonly deviceMapRepo: Repository<DeviceMapStateEntity>,
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
      return await this.upsertDownloadStatus(newStatus)
    }

    const map = await this.mapRepo.findOneBy({ catalogId: dlvStatus.catalogId })
    if (map) {
      const isSaved = await this.upsertDownloadStatus(newStatus)

      if (isSaved){
        this.logger.log(`Save state of map ${map.catalogId} for device ${device.ID}`)
        let deviceMap = this.deviceMapRepo.create({ device, map, state: DeviceMapStateEnum.DELIVERY })

        this.deviceMapRepo.upsert(deviceMap, ['device', 'map'])
      }
      return isSaved
    }
    throw new BadRequestException(`Not found Item with this catalogId: ${dlvStatus.catalogId}`);
  }

  private async upsertDownloadStatus(newStatus: DeliveryStatusEntity): Promise<Boolean> {
    let savedMap: any = await this.deliveryStatusRepo.createQueryBuilder()
        .insert()
        .values({...newStatus})
        .orIgnore()
        .execute()

      if (savedMap?.raw?.length == 0){
        savedMap = await this.deliveryStatusRepo.createQueryBuilder()
          .update()
          .set({...newStatus})
          .where("deviceID = :deviceID", {deviceID: newStatus.device.ID})
          .andWhere("catalogId = :catalogId", {catalogId: newStatus.catalogId})
          .andWhere("current_time < :current_time", {current_time: newStatus.currentTime})
          .execute()
      }
      
      return savedMap?.raw?.length > 0 || savedMap.affected > 0
  }

  async prepareDelivery(prepDlv: PrepareDeliveryReqDto): Promise<PrepareDeliveryResDto> {
    let prepRes = new PrepareDeliveryResDto()
    prepRes.catalogId = prepDlv.catalogId;
    const comp = await this.uploadVersionRepo.findOneBy({ catalogId: prepDlv.catalogId });
    if (comp && comp.uploadStatus == UploadStatus.READY) {
      prepRes.status = PrepareStatusEnum.DONE;
      prepRes.url = await this.s3Service.generatePresignedUrlForDownload(comp.s3Url);
      return prepRes;
    }
    const map = await this.mapRepo.findOneBy({ catalogId: prepDlv.catalogId });

    if (map) {
      if (map.status == MapImportStatusEnum.DONE) {
        prepRes.status = PrepareStatusEnum.DONE;
        prepRes.url = map.packageUrl;
      } else if (map.status == MapImportStatusEnum.IN_PROGRESS || map.status == MapImportStatusEnum.START) {
        prepRes.status = PrepareStatusEnum.IN_PROGRESS;
      } else {
        prepRes.status = PrepareStatusEnum.ERROR;
      }
      return prepRes
    }
    this.logger.error(`Cannot find an Item with catalogId: ${prepDlv.catalogId}`);

    prepRes.status = PrepareStatusEnum.ERROR;
    return prepRes
  }

  async getPrepareDeliveryStatus(catalogId: string): Promise<PrepareDeliveryResDto> {
    let prepRes = new PrepareDeliveryResDto()
    prepRes.catalogId = catalogId;

    const comp = await this.uploadVersionRepo.findOneBy({ catalogId: catalogId });
    if (comp && comp.uploadStatus == UploadStatus.READY) {
      prepRes.status = PrepareStatusEnum.DONE;
      prepRes.url = await this.s3Service.generatePresignedUrlForDownload(comp.s3Url);
      return prepRes;
    }

    const map = await this.mapRepo.findOneBy({ catalogId: catalogId });
    if (map) {
      if (map.status == MapImportStatusEnum.DONE) {
        prepRes.status = PrepareStatusEnum.DONE;
        prepRes.url = map.packageUrl;
      } else if (map.status == MapImportStatusEnum.IN_PROGRESS || map.status == MapImportStatusEnum.START) {
        prepRes.status = PrepareStatusEnum.IN_PROGRESS;
      } else {
        prepRes.status = PrepareStatusEnum.ERROR;
      }
      return prepRes
    }

    this.logger.error(`Error getting prepared delivery status : ${catalogId}`);

    prepRes.status = PrepareStatusEnum.ERROR;
    return prepRes

  }


  // async preparePackage(data: PackageMessageDto) {
  //   try {

  //     this.packageInPreparation = await this.savePackageInfo(data)
  //     if (this.packageInPreparation) {
  //       const urls = await this.getPackageURL(data)

  //       const url = urls || "http://getapp-dev.getapp.sh:8082/artifactory/getapp-test/entry-point.sh"

  //       this.artifactory.getArtifacts(url).subscribe((res: any | null) => {

  //         if (res?.data) {

  //           const filePath = __dirname + "/artifacts/"
  //           let fileName: any = url.split("/")
  //           fileName = fileName[fileName.length - 1]

  //           try {
  //             if (!existsSync(filePath)) {
  //               mkdirSync(filePath, { recursive: true });
  //             }
  //             const file = createWriteStream(filePath + fileName);
  //             file.write(res.data)
  //           } catch (error) {
  //             console.log("err: ", error);

  //           }

  //           // taking from artifactory
  //           // putting in s3

  //           const s3_URL = "https://google.com"
  //           const ready = true
  //           if (ready) {
  //             this.updatePackageAsReady(s3_URL)
  //           }
  //         }
  //       })
  //     }
  //   } catch (error) {
  //     console.error("error: ", { message: error.message, stack: error.stack, detail: error.driverError?.detail });
  //   }

  // }


  // async savePackageInfo(data: PackageMessageDto): Promise<VersionPackagesEntity> {
  //   const versionPackage = this.versionPackageRepo.create(data);
  //   const isExist = await this.versionPackageRepo.findOne({ select: ["id"], where: data })
  //   if (!isExist) {
  //     return this.versionPackageRepo.save(versionPackage)
  //   } else {
  //     return null
  //   }
  // }

  // updatePackageAsReady(url: string) {
  //   return this.versionPackageRepo.update(this.packageInPreparation.id, { status: PackageStatus.READY, utl: url })
  // }

  // async getPackageURL(data: PackageMessageDto) {
  //   const urlData = await this.uploadVersionRepo.findOne({
  //     select: ["url"], where:
  //     {
  //       component: data.OS,
  //       formation: data.formation,
  //       version: data.toVersion
  //     }
  //   })
  //   return urlData?.s3Url
  // }
}
