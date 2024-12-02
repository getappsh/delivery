import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { PrepareService } from './prepare.service';
import { DownloadService } from './download.service';
import { HttpClientService } from './http-client.service';
import { S3Service } from '@app/common/AWS/s3.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryEntity, DeliveryItemEntity } from '@app/common/database-tng/entities';
import { HttpConfigModule } from '@app/common/http-config/http-config.module';
import { ManagementService } from './management.service';
import { CacheConfigEntity } from '@app/common/database-tng/entities/cache-config.entity';
import { ScheduleModule } from '@nestjs/schedule';
import { SafeCronModule } from '@app/common/safe-cron';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    HttpModule,
    HttpConfigModule,
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forFeature([
      DeliveryEntity,
      DeliveryItemEntity,
      CacheConfigEntity
    ]),
    SafeCronModule
  ],
  providers: [PrepareService, DownloadService, HttpClientService, S3Service, ManagementService],
  exports: [PrepareService, ManagementService]
})
export class CacheModule { }
