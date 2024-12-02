import { DatabaseModule } from '@app/common';
import { S3Service } from '@app/common/AWS/s3.service';
import { UploadVersionEntity, ProjectEntity, MemberProjectEntity, MemberEntity, DeliveryStatusEntity, DeviceEntity, MapEntity, DeviceMapStateEntity, DeliveryEntity } from '@app/common/database/entities';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { PrepareService } from './prepare.service';
import { HttpModule } from '@nestjs/axios';

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
      DeliveryEntity
    ]),
    HttpModule,
  ],
  controllers: [DeliveryController],
  providers: [DeliveryService, S3Service, PrepareService],
})
export class CtsModule {}
