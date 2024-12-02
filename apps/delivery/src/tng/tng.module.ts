import { Module } from '@nestjs/common';
import { S3Service } from '@app/common/AWS/s3.service';
import { DeliveryEntity } from '@app/common/database/entities/delivery.entity';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DownloadService } from './download.service';
import { HttpClientService } from './http-client.service';
import { TngDatabaseModule } from '@app/common/database-tng/tng-database.module';
import { HttpConfigService } from '@app/common/utils/http-config.service';

@Module({
  imports: [
    TngDatabaseModule,
    HttpModule,
    TypeOrmModule.forFeature([
      DeliveryEntity
    ])
  ],
  controllers: [DeliveryController],
  providers: [DeliveryService, S3Service, HttpClientService, DownloadService, HttpConfigService],
})
export class TngModule {}
