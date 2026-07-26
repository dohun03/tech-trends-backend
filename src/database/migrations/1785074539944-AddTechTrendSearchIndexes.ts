import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTechTrendSearchIndexes1785074539944 implements MigrationInterface {

  name = 'AddTechTrendSearchIndexes1785074539944';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_created_at"
      ON "tbl_tech_trends" ("created_at" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_mined_at"
      ON "tbl_tech_trends" ("mined_at" DESC);
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_tech_trends_fts";
    `);

    await queryRunner.query(`
      ALTER TABLE "tbl_tech_trends"
      DROP COLUMN IF EXISTS "search_document";
    `);

    await queryRunner.query(`
      ALTER TABLE "tbl_tech_trends"
      ADD COLUMN "search_document" tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
        setweight(to_tsvector('simple', coalesce("technical_tags", '')), 'A')
      ) STORED;
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_tech_trends_fts"
      ON "tbl_tech_trends" USING GIN ("search_document");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tech_trends_fts";`);
    await queryRunner.query(`ALTER TABLE "tbl_tech_trends" DROP COLUMN IF EXISTS "search_document";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mined_at";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_created_at";`);
  }
}
