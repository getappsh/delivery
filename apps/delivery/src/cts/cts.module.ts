import { DatabaseModule } from '@app/common';
import { S3Service } from '@app/common/AWS/s3.service';
import { UploadVersionEntity, ProjectEntity, MemberProjectEntity, MemberEntity, DeliveryStatusEntity, DeviceEntity, MapEntity, DeviceMapStateEntity } from '@app/common/database/entities';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { HttpModule } from '@nestjs/axios';
import { HttpClientService } from './http-client.service';
import { HttpConfigModule } from '@app/common/http-config/http-config.module';
import { DeliveryEntity, DeliveryItemEntity } from '@app/common/database-tng/entities';
import { CacheModule } from '../cache/cache.module';

@Module({
  imports: [
    // ArtifactoryModule,
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    TypeOrmModule.forFeature([
      UploadVersionEntity,
      ProjectEntity,
      MemberProjectEntity,
      MemberEntity,
      DeliveryStatusEntity,
      DeviceEntity,
      MapEntity,
      DeviceMapStateEntity,
      DeliveryEntity,
      DeliveryItemEntity
    ]),
    HttpModule,
    HttpConfigModule,
    CacheModule
  ],
  controllers: [DeliveryController],
  providers: [DeliveryService, S3Service, HttpClientService],
})
export class CtsModule { }
