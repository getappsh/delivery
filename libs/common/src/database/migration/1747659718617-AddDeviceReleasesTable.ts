import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDeviceReleasesTable1747659718617 implements MigrationInterface {
    name = 'AddDeviceReleasesTable1747659718617'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "device_releases" (
                "device_id" character varying NOT NULL,
                "release_catalog_id" character varying NOT NULL,
                CONSTRAINT "PK_device_releases" PRIMARY KEY ("device_id", "release_catalog_id")
            )
        `);
        await queryRunner.query(`
            ALTER TABLE "device_releases"
            ADD CONSTRAINT "FK_device_releases_device_id"
            FOREIGN KEY ("device_id") REFERENCES "device"("ID") ON DELETE CASCADE ON UPDATE CASCADE
        `);
        await queryRunner.query(`
            ALTER TABLE "device_releases"
            ADD CONSTRAINT "FK_device_releases_release_catalog_id"
            FOREIGN KEY ("release_catalog_id") REFERENCES "release"("catalog_id") ON DELETE CASCADE ON UPDATE CASCADE
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "device_releases" DROP CONSTRAINT "FK_device_releases_release_catalog_id"`);
        await queryRunner.query(`ALTER TABLE "device_releases" DROP CONSTRAINT "FK_device_releases_device_id"`);
        await queryRunner.query(`DROP TABLE "device_releases"`);
    }
}
