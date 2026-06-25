import { Module } from '@nestjs/common';
import {  OriginModule } from '../origin/origin.module';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from '@app/common/logger/logger.module';
import { ProxyModule } from '../proxy/proxy.module';
import { ApmModule } from '@app/common/apm/apm.module';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DatabaseModule } from '@app/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryStatusEntity, DeviceEntity, MapEntity, ReleaseEntity } from '@app/common/database/entities';
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
    MicroserviceModule.register({
      name: MicroserviceName.PROJECT_MANAGEMENT_SERVICE,
      type: MicroserviceType.PROJECT_MANAGEMENT,
    }),
    MicroserviceModule.register({
      name: MicroserviceName.API_SERVICE,
      type: MicroserviceType.API,
    }),
    MicroserviceModule.register({
      name: MicroserviceName.DEPLOY_SERVICE,
      type: MicroserviceType.DEPLOY,
    }),
    DatabaseModule,
    TypeOrmModule.forFeature([
      ReleaseEntity,
      DeliveryStatusEntity,
      DeviceEntity,
      MapEntity
    ]),
    process.env.IS_PROXY === "true" ? ProxyModule : OriginModule,
    CacheModule,
    ApmModule,
  ],
  controllers: [DeliveryController],
  providers: [DeliveryService]
})
export class DeliveryModule { }
