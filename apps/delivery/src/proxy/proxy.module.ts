import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DeliveryController } from './proxy-delivery.controller';
import { DeliveryService } from './proxy-delivery.service';
import { ProxyDatabaseModule } from '@app/common/database-proxy/proxy-database.module';
import { CacheModule } from '../cache/cache.module';
import { HttpClientService } from './http-client.service';
import { HttpConfigModule } from '@app/common/http-config/http-config.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryEntity } from '@app/common/database-proxy/entities';

@Module({
  imports: [
    ProxyDatabaseModule,
    HttpModule,
    HttpConfigModule,
    CacheModule,
    TypeOrmModule.forFeature([
      DeliveryEntity,
    ]),
  ],
  controllers: [DeliveryController],
  providers: [DeliveryService, HttpClientService],
})
export class ProxyModule { }
