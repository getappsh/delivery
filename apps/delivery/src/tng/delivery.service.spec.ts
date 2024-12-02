import { Test, TestingModule } from '@nestjs/testing';
import { DeliveryService } from './delivery.service';
import { S3Service } from '@app/common/AWS/s3.service';
import { DownloadService } from './download.service';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DeliveryEntity } from '@app/common/database-tng/entities/delivery.entity';
import { mockDeliveryRepo } from '@app/common/database-tng/test/support/__mocks__';
import { deliveryEntityStub } from '@app/common/database-tng/test/support/subs';
import { PrepareStatusEnum } from '@app/common/dto/delivery';
import { prepareDeliveryReqDtoStub } from '@app/common/dto/delivery/stubs/prepare-delivery-res.dot.sub';

describe('DeliveryService', () => {
  let deliveryService: DeliveryService;
  let s3Service: S3Service;
  let downloadService: DownloadService;
  let deliveryRepository: Repository<DeliveryEntity>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryService,
        {
          provide: S3Service,
          useValue: {
            generatePresignedUrlForDownload: jest.fn(),
          },
        },
        {
          provide: DownloadService,
          useValue: {
            startDownloading: jest.fn(),
            startDownloadIfStopped: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(DeliveryEntity),
          useValue: mockDeliveryRepo()
        },
      ],
    }).compile();

    deliveryService = module.get<DeliveryService>(DeliveryService);
    s3Service = module.get<S3Service>(S3Service);
    downloadService = module.get<DownloadService>(DownloadService);
    deliveryRepository = module.get<Repository<DeliveryEntity>>(getRepositoryToken(DeliveryEntity));
  
    jest.clearAllMocks();
  });

  describe('prepareDelivery', () => {
    it('should prepare delivery and start downloading', async () => {
      const prepDlv = prepareDeliveryReqDtoStub();

      const dlvEntity = deliveryEntityStub(); 

      deliveryRepository.findOneBy = jest.fn().mockResolvedValueOnce(undefined);
      downloadService.startDownloading = jest.fn();

      const result = await deliveryService.prepareDelivery(prepDlv);
      
      expect(result).toEqual({catalogId: prepDlv.catalogId, status: dlvEntity.status})

      expect(deliveryRepository.findOneBy).toHaveBeenCalledWith({ catalogId: prepDlv.catalogId });
      expect(deliveryRepository.save).toHaveBeenCalledWith(expect.any(DeliveryEntity));
      expect(downloadService.startDownloading).toHaveBeenCalledWith(prepDlv.catalogId , expect.any(String));
    });

    it('should return in progress and not start downloading', async () => {
      const prepDlv = prepareDeliveryReqDtoStub();

      const dlvEntity = deliveryEntityStub(); 
      dlvEntity.status = PrepareStatusEnum.IN_PROGRESS;

      deliveryRepository.findOneBy = jest.fn().mockResolvedValueOnce(dlvEntity);
 
      const result = await deliveryService.prepareDelivery(prepDlv);
      
      expect(result).toEqual({catalogId: prepDlv.catalogId, status: dlvEntity.status})

      expect(deliveryRepository.findOneBy).toHaveBeenCalledWith({ catalogId: prepDlv.catalogId });
      expect(deliveryRepository.save).not.toHaveBeenCalled();
      expect(downloadService.startDownloading).not.toBeCalled();
      expect(downloadService.startDownloadIfStopped).toBeCalledWith(dlvEntity)
    });

  });

  describe('getPreparedDeliveryStatus', () => {
    it('should get prepared delivery status and start download if needed', async () => {
      const catalogId = prepareDeliveryReqDtoStub().catalogId;
      const dlvStatus = deliveryEntityStub().status;

      const result = await deliveryService.getPreparedDeliveryStatus(catalogId);
      expect(result).toEqual({catalogId: catalogId, status: dlvStatus})

      expect(deliveryRepository.findOneBy).toHaveBeenCalledWith({ catalogId });
      expect(s3Service.generatePresignedUrlForDownload).not.toHaveBeenCalled();
      expect(downloadService.startDownloadIfStopped).toHaveBeenCalled();
    });

    it('should get prepared delivery status Done', async () => {
      const catalogId = prepareDeliveryReqDtoStub().catalogId;
      const mockDownloadUrl = "url/to/download/form"

      const dlvEntity = deliveryEntityStub();
      dlvEntity.status = PrepareStatusEnum.DONE;

      deliveryRepository.findOneBy = jest.fn().mockResolvedValueOnce(dlvEntity);
      s3Service.generatePresignedUrlForDownload = jest.fn().mockResolvedValueOnce(mockDownloadUrl);

      const result = await deliveryService.getPreparedDeliveryStatus(catalogId);
      expect(result).toEqual({catalogId: catalogId, status: dlvEntity.status, url: mockDownloadUrl})

      expect(deliveryRepository.findOneBy).toHaveBeenCalledWith({ catalogId });
      expect(s3Service.generatePresignedUrlForDownload).toHaveBeenCalledWith(expect.any(String));
      expect(downloadService.startDownloadIfStopped).toHaveBeenCalledWith(dlvEntity);
    });

    it('should throw NotFoundException when delivery not found', async () => {
      const catalogId = prepareDeliveryReqDtoStub().catalogId;

      deliveryRepository.findOneBy = jest.fn().mockResolvedValue(undefined);

      await expect(deliveryService.getPreparedDeliveryStatus(catalogId)).rejects.toThrowError(NotFoundException);

      expect(deliveryRepository.findOneBy).toHaveBeenCalledWith({ catalogId });
      expect(downloadService.startDownloadIfStopped).not.toHaveBeenCalled();
      expect(s3Service.generatePresignedUrlForDownload).not.toHaveBeenCalled();


    });

    // Write more tests for other scenarios
  });

});