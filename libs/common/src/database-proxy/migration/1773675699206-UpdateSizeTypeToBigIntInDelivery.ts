import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateSizeTypeToBigIntInDelivery1773675699206 implements MigrationInterface {
    name = 'UpdateSizeTypeToBigIntInDelivery1773675699206'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "delivery_item" ALTER COLUMN "size" TYPE bigint`);
        await queryRunner.query(`ALTER TABLE "delivery" ALTER COLUMN "size" TYPE bigint`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "delivery_item" ALTER COLUMN "size" TYPE integer`);
        await queryRunner.query(`ALTER TABLE "delivery" ALTER COLUMN "size" TYPE integer`);
    }

}
