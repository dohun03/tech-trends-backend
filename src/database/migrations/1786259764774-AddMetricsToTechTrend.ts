import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMetricsToTechTrend1786259764774 implements MigrationInterface {

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tbl_tech_trends"
      ADD COLUMN "view_count" integer,
      ADD COLUMN "like_count" integer,
      ADD COLUMN "comment_count" integer;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tbl_tech_trends"
      DROP COLUMN IF EXISTS "comment_count",
      DROP COLUMN IF EXISTS "like_count",
      DROP COLUMN IF EXISTS "view_count";
    `);
  }
}
