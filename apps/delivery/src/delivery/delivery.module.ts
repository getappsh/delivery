import { Module } from '@nestjs/common';
import { CtsModule } from '../cts/cts.module';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from '@app/common/logger/logger.module';
import { TngModule } from '../tng/tng.module';
import { ApmModule } from '@app/common/apm/apm.module';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DatabaseModule } from '@app/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UploadVersionEntity, DeliveryStatusEntity, DeviceEntity, MapEntity, DeviceMapStateEntity } from '@app/common/database/entities';
import { CacheModule } from '../cache/cache.module';
import { MicroserviceModule, MicroserviceName, MicroserviceType } from '@app/common/microservice-client';


@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({ httpCls: false, jsonLogger: process.env.LOGGER_FORMAT === 'JSON', name: "Delivery" }),
    MicroserviceModule.register({
      name: MicroserviceName.DISCOVERY_SERVICE,
      type: MicroserviceType.DISCOVERY,
    }),
    DatabaseModule,
    TypeOrmModule.forFeature([
      UploadVersionEntity,
      DeliveryStatusEntity,
      DeviceEntity,
      MapEntity
    ]),
    process.env.IS_PROXY === "true" ? TngModule : CtsModule,
    CacheModule,
    ApmModule,
  ],
  controllers: [DeliveryController],
  providers: [DeliveryService]
})
export class DeliveryModule { }
