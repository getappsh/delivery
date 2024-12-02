import * as dotenv from 'dotenv';
dotenv.config();
import apm from 'nestjs-elastic-apm';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { CustomRpcExceptionFilter } from '../rpc-exception.filter';
import { DeliveryModule } from './delivery.module';
import { MSType, MicroserviceName, MicroserviceType, getClientConfig } from '@app/common/microservice-client';
import { GET_APP_LOGGER } from '@app/common/logger/logger.module';
// require('dotenv').config()


async function bootstrap() {  
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    DeliveryModule,
    {...getClientConfig(
      {
        type: MicroserviceType.DELIVERY, 
        name: MicroserviceName.DELIVERY_SERVICE
      }, 
      MSType[process.env.MICRO_SERVICE_TYPE]),
      bufferLogs: true
    }
  );

  app.useLogger(app.get(GET_APP_LOGGER))
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new CustomRpcExceptionFilter())
  app.listen()
}

bootstrap();