import { MigrationInterface, QueryRunner } from "typeorm";

export class InitTechTrendSchema1785067830260 implements MigrationInterface {
  name = 'InitTechTrendSchema1785067830260';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // pgvector 확장 기능 활성화
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

    // 테이블 기본 구조 생성
    await queryRunner.query(`
      CREATE TABLE "tbl_tech_trends" (
        "id" SERIAL NOT NULL,
        "source" character varying(50) NOT NULL,
        "source_id" character varying(100) NOT NULL,
        "title" character varying(255) NOT NULL,
        "short_summary" jsonb NOT NULL,
        "long_summary" text,
        "link_url" character varying(512) NOT NULL,
        "technical_tags" character varying(255),
        "embedding" vector(1536),
        "created_at" date NOT NULL,
        "mined_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_link_url" UNIQUE ("link_url"),
        CONSTRAINT "UQ_source_source_id" UNIQUE ("source", "source_id"),
        CONSTRAINT "PK_tbl_tech_trends_id" PRIMARY KEY ("id")
      );
    `);

    // 일반 인덱스 생성
    await queryRunner.query(`
      CREATE INDEX "IDX_source_created_at" ON "tbl_tech_trends" ("source", "created_at");
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_technical_tags" ON "tbl_tech_trends" ("technical_tags");
    `);

    // Full-Text Search(FTS)용 STORED GENERATED 컬럼 추가
    await queryRunner.query(`
      ALTER TABLE "tbl_tech_trends" 
      ADD COLUMN "search_document" tsvector 
      GENERATED ALWAYS AS (
        to_tsvector('english', coalesce("title", '') || ' ' || coalesce("technical_tags", ''))
      ) STORED;
    `);

    // GIN 인덱스 생성 (키워드 검색용)
    await queryRunner.query(`
      CREATE INDEX "IDX_tech_trends_fts" 
      ON "tbl_tech_trends" USING GIN ("search_document");
    `);

    // HNSW 인덱스 생성 (벡터 검색용)
    await queryRunner.query(`
      CREATE INDEX "IDX_tech_trends_embedding" 
      ON "tbl_tech_trends" USING hnsw ("embedding" vector_cosine_ops);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 롤백 시 역순으로 삭제
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tech_trends_embedding";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tech_trends_fts";`);
    await queryRunner.query(`ALTER TABLE "tbl_tech_trends" DROP COLUMN IF EXISTS "search_document";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_technical_tags";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_source_created_at";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tbl_tech_trends";`);
  }
}
