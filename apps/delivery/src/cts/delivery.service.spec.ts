import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DeliveryStatusEntity, DeviceEntity, DeviceMapStateEntity, MapEntity, UploadVersionEntity } from "@app/common/database/entities";
import { mockDeliveryStatusRepo, mockDeviceRepo, mockMapRepo, mockUploadVersionRepo } from "@app/common/database/test/support/__mocks__";
import { Repository } from "typeorm";
import { NotFoundException } from "@nestjs/common";
import { DeliveryService } from "./delivery.service";
import { deliveryStatusDtoStub } from "@app/common/dto/delivery";
import { S3Service } from "@app/common/AWS/s3.service";

const mocks3Service = {
  generatePresignedUrlForDownload: jest.fn().mockResolvedValue("path/to/download/url")
}

 describe('DeliveryService', () => {
    let s3Service: S3Service; 
    let deliveryService: DeliveryService;
    let deliveryRepo: Repository<DeliveryStatusEntity>;
    let uploadVersionRepo: Repository<UploadVersionEntity>;
    let deviceRepo: Repository<DeviceEntity>;
    let mapRepo: Repository<MapEntity>;


    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DeliveryService,
          {
            provide: S3Service,
            useValue:  mocks3Service
          },
          {
            provide: getRepositoryToken(DeliveryStatusEntity),
            useValue: mockDeliveryStatusRepo()
          },
          {
            provide: getRepositoryToken(UploadVersionEntity),
            useValue: mockUploadVersionRepo()
          },
          {
            provide: getRepositoryToken(DeviceEntity),
            useValue: mockDeviceRepo()
          },
          {
            provide: getRepositoryToken(MapEntity),
            useValue: mockMapRepo()
          },
          {
            provide: getRepositoryToken(DeviceMapStateEntity),
            useValue: {}
          },
        ],
    }).compile()

      s3Service = module.get<S3Service>(S3Service);
      deliveryService = module.get<DeliveryService>(DeliveryService);
      deliveryRepo = module.get<Repository<DeliveryStatusEntity>>(getRepositoryToken(DeliveryStatusEntity));
      uploadVersionRepo = module.get<Repository<UploadVersionEntity>>(getRepositoryToken(UploadVersionEntity));
      deviceRepo = module.get<Repository<DeviceEntity>>(getRepositoryToken(DeviceEntity));
      mapRepo = module.get<Repository<MapEntity>>(getRepositoryToken(MapEntity));

      jest.clearAllMocks();
    })
    
    describe('updateDeliveryStatus', () => {
      it('should create and save a new delivery status', async () => {
        const deliveryStatus = deliveryStatusDtoStub()
        const mockCreatedDeliveryStatus = deliveryRepo.create(deliveryStatus);

        const result = await deliveryService.updateDownloadStatus(deliveryStatus);

        expect(result).toEqual(mockCreatedDeliveryStatus);
        expect(deliveryRepo.create).toHaveBeenCalledWith(deliveryStatus);
        expect(deviceRepo.findOne).toHaveBeenCalledWith({where: {ID: deliveryStatus.deviceId}})
        expect(uploadVersionRepo.findOneBy).toHaveBeenCalledWith({ catalogId: deliveryStatus.catalogId });
        expect(mapRepo.findOneBy).not.toHaveBeenCalled()
        expect(deliveryRepo.save).toHaveBeenCalledWith(mockCreatedDeliveryStatus);

      });

      it('should throw NotFoundException if device is not found', async () => {
        const deployStatus = deliveryStatusDtoStub()
        
        deviceRepo.findOne = jest.fn().mockImplementationOnce(()=> undefined);
          
        await expect(deliveryService.updateDownloadStatus(deployStatus)).rejects.toThrowError(
          NotFoundException,
        );
        expect(deliveryRepo.create).toHaveBeenCalled();
        expect(deviceRepo.findOne).toHaveBeenCalledWith({where: {ID: deployStatus.deviceId}})
        expect(uploadVersionRepo.findOne).not.toHaveBeenCalledWith();
        expect(mapRepo.findOneBy).not.toHaveBeenCalled()
        expect(deliveryRepo.save).not.toHaveBeenCalled();
      }); 

      it('should throw NotFoundException if component is not found', async () => {
        const deliveryStatus = deliveryStatusDtoStub()
        
        uploadVersionRepo.findOneBy = jest.fn().mockImplementationOnce(()=> undefined);
        mapRepo.findOneBy = jest.fn().mockImplementationOnce(()=> undefined);

          
        await expect(deliveryService.updateDownloadStatus(deliveryStatus)).rejects.toThrowError(
          NotFoundException,
        );
        expect(deliveryRepo.create).toHaveBeenCalled();
        expect(deviceRepo.findOne).toHaveBeenCalledWith({where: {ID: deliveryStatus.deviceId}})
        expect(uploadVersionRepo.findOneBy).toHaveBeenCalledWith({ catalogId: deliveryStatus.catalogId });
        expect(mapRepo.findOneBy).toHaveBeenCalledWith({ catalogId: deliveryStatus.catalogId });
        expect(deliveryRepo.save).not.toHaveBeenCalled();
      });  
    });
 });
