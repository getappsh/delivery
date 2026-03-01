import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosRequestConfig } from 'axios';

@Injectable()
export class WrapHttpService {
  constructor(private readonly httpService: HttpService, private configService: ConfigService) { }

  async artifactoryWrapper(method: string, data?: any, config?: AxiosRequestConfig) {
    const url = this.configService.get<string>("JFROG_BASE_URL") + this.configService.get<string>("JFROG_REPO")
    const auth = {
      auth: {
        username: this.configService.get<string>("JFROG_USEN_NAME"),
        password: this.configService.get<string>("JFROG_PASSWORD")
      }
    }
    
    if (method === ("get" || "delete")) {
      return await this.httpService.axiosRef[method](url, { ...config, ...auth })
    }    
    return await this.httpService.axiosRef[method](url, data, { ...config, ...auth })
  }
}
