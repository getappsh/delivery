import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MapEntity, MapImportStatusEnum, UploadStatus, UploadVersionEntity, PrepareStatusEnum, HashAlgorithmEnum, ItemTypeEnum, AssetTypeEnum, ReleaseEntity, ReleaseStatusEnum, ReleaseArtifactEntity, ArtifactTypeEnum } from '@app/common/database/entities';
import { PrepareDeliveryResDto } from '@app/common/dto/delivery';
import { S3Service } from '@app/common/AWS/s3.service';
import { DeliveryItemDto } from '@app/common/dto/delivery/dto/delivery-item.dto';
import { HttpClientService } from './http-client.service';
import { DeliveryError } from '@app/common/dto/delivery/dto/delivery-error';
import { ErrorCode, ErrorDto } from '@app/common/dto/error';
import { ConfigService } from '@nestjs/config';
import { MinioClientService } from '@app/common/AWS/minio-client.service';

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  private readonly bucketName = this.configService.get('BUCKET_NAME');


  constructor(
    // private readonly artifactory: ArtifactoryService,
    private readonly configService: ConfigService,
    private readonly minioClient: MinioClientService,
    private s3Service: S3Service,
    private httpService: HttpClientService,
    @InjectRepository(UploadVersionEntity) private readonly uploadVersionRepo: Repository<UploadVersionEntity>,
    @InjectRepository(MapEntity) private readonly mapRepo: Repository<MapEntity>,
    @InjectRepository(ReleaseEntity) private readonly releaseRepo: Repository<ReleaseEntity>,
  ) { }


  async prepareDeliveryV2(catalogId: string): Promise<PrepareDeliveryResDto> {
    let prepRes = new PrepareDeliveryResDto()
    prepRes.catalogId = catalogId;
    try {
      const release = await this.releaseRepo.findOne({
        where: { catalogId },
        relations: { artifacts: {fileUpload: true}} 
      });

      if (release) {
        if (release.status == ReleaseStatusEnum.RELEASED) {
          return await this.getCompPrepDlvResV2(release, prepRes)
        } else {
          const msg = `Catalog Id '${catalogId}' package, not yet available for delivery`
          this.logger.warn(msg)
          throw new DeliveryError(ErrorCode.DLV_DOWNLOAD_NOT_AVAILABLE, msg)
        }
      }

      const map = await this.mapRepo.findOneBy({ catalogId });
      if (map) {
        if (map.status == MapImportStatusEnum.DONE) {
          return await this.getMapPrepDlvRes(map, prepRes)
        } else {
          const msg = `Catalog Id '${catalogId}' package, not yet available for delivery`
          this.logger.warn(msg)
          throw new DeliveryError(ErrorCode.DLV_DOWNLOAD_NOT_AVAILABLE, msg)
        }
      }

      const msg = `Item not found, catalog Id: ${catalogId}`
      throw new DeliveryError(ErrorCode.DLV_NOT_FOUND, msg)
    } catch (error) {

      prepRes.status = PrepareStatusEnum.ERROR;
      prepRes.error = new ErrorDto()
      prepRes.error.message = error.message
      if (error instanceof DeliveryError) {
        this.logger.error(error);
        prepRes.error.errorCode = error.errorCode
      } else {
        this.logger.error(`Error getting prepared delivery status : ${catalogId}`, error);
        prepRes.error.errorCode = ErrorCode.DLV_OTHER
      }
      return prepRes
    }

  }


  async prepareDelivery(catalogId: string): Promise<PrepareDeliveryResDto> {
    let prepRes = new PrepareDeliveryResDto()
    prepRes.catalogId = catalogId;
    try {
      const comp = await this.uploadVersionRepo.findOneBy({ catalogId });
      if (comp) {
        if (comp.uploadStatus == UploadStatus.READY) {
          return await this.getCompPrepDlvRes(comp, prepRes)
        } else {
          const msg = `Catalog Id '${catalogId}' package, not yet available for delivery`
          this.logger.warn(msg)
          throw new DeliveryError(ErrorCode.DLV_DOWNLOAD_NOT_AVAILABLE, msg)
        }
      }

      const map = await this.mapRepo.findOneBy({ catalogId });
      if (map) {
        if (map.status == MapImportStatusEnum.DONE) {
          return await this.getMapPrepDlvRes(map, prepRes)
        } else {
          const msg = `Catalog Id '${catalogId}' package, not yet available for delivery`
          this.logger.warn(msg)
          throw new DeliveryError(ErrorCode.DLV_DOWNLOAD_NOT_AVAILABLE, msg)
        }
      }

      const msg = `Item not found, catalog Id: ${catalogId}`
      throw new DeliveryError(ErrorCode.DLV_NOT_FOUND, msg)
    } catch (error) {

      prepRes.status = PrepareStatusEnum.ERROR;
      prepRes.error = new ErrorDto()
      prepRes.error.message = error.message
      if (error instanceof DeliveryError) {
        this.logger.error(error);
        prepRes.error.errorCode = error.errorCode
      } else {
        this.logger.error(`Error getting prepared delivery status : ${catalogId}`, error);
        prepRes.error.errorCode = ErrorCode.DLV_OTHER
      }
      return prepRes
    }

  }

  async getMapPrepDlvRes(map: MapEntity, prepRes: PrepareDeliveryResDto): Promise<PrepareDeliveryResDto> {
    prepRes.status = PrepareStatusEnum.DONE;
    prepRes.url = map.packageUrl;
    let jsonArtifacts = new DeliveryItemDto()
    jsonArtifacts.catalogId = prepRes.catalogId;
    jsonArtifacts.itemKey = "json"
    jsonArtifacts.url = this.changeExtensionToJson(map.packageUrl);
    jsonArtifacts.metaData = ItemTypeEnum.MAP.toString()


    let mapJson = await this.httpService.getMapJson(jsonArtifacts.url);

    let geoArtifacts = new DeliveryItemDto()
    geoArtifacts.catalogId = prepRes.catalogId;
    geoArtifacts.itemKey = "gpkg"
    geoArtifacts.url = map.packageUrl;
    geoArtifacts.metaData = ItemTypeEnum.MAP.toString()
    if (mapJson.sha256) {
      geoArtifacts.hash = {
        algorithm: HashAlgorithmEnum.SHA256Hex,
        hash: mapJson.sha256
      }
    }

    prepRes.Artifacts = [geoArtifacts, jsonArtifacts];

    return prepRes
  }

  async getCompPrepDlvResV2(release: ReleaseEntity, prepRes: PrepareDeliveryResDto): Promise<PrepareDeliveryResDto> {
    prepRes.status = PrepareStatusEnum.DONE;

    const artifacts = []
    for (const art of release.artifacts) {
      if (!art.isInstallationFile) continue;
      
      let compArtifacts = new DeliveryItemDto()
      compArtifacts.catalogId = prepRes.catalogId;
      compArtifacts.id = art.id

      // compArtifacts.metaData = JSON.stringify(art.metadata);

      if(art.type === ArtifactTypeEnum.DOCKER_IMAGE){
        compArtifacts.metaData = AssetTypeEnum.DOCKER_IMAGE;
        compArtifacts.url = art.dockerImageUrl

        // TODO set item-key
      }else {
        compArtifacts.metaData = ItemTypeEnum.SOFTWARE
        compArtifacts.size = art.fileUpload?.size;
        compArtifacts.url = await this.minioClient.generatePresignedDownloadUrl(this.bucketName, art.fileUpload.objectKey);
        
        // Maybe change this to file type
        compArtifacts.itemKey = `${prepRes.catalogId}@${art.fileUpload.fileName}`;

      }
      artifacts.push(compArtifacts)      
    }

    prepRes.Artifacts = artifacts

    return prepRes
  }

  async getCompPrepDlvRes(comp: UploadVersionEntity, prepRes: PrepareDeliveryResDto): Promise<PrepareDeliveryResDto> {
    prepRes.status = PrepareStatusEnum.DONE;
    let compArtifacts = new DeliveryItemDto()
    compArtifacts.catalogId = prepRes.catalogId;
    compArtifacts.itemKey = comp.url.substring(comp.url.lastIndexOf(".") + 1)
    compArtifacts.size = comp.virtualSize

    let url
    if (comp.assetType == AssetTypeEnum.DOCKER_IMAGE){
      compArtifacts.metaData = AssetTypeEnum.DOCKER_IMAGE;
      url = comp.url
    }else{
      compArtifacts.metaData = ItemTypeEnum.SOFTWARE
      url = await this.s3Service.generatePresignedUrlForDownload(comp.url)
    }
    prepRes.url = url;
    compArtifacts.url = url


    prepRes.Artifacts = [compArtifacts];

    return prepRes
  }

  private changeExtensionToJson(s: string): string {
    return s.substring(0, s.lastIndexOf(".")) + ".json"
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
