import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

@Entity('tbl_tech_trends')
@Unique('UQ_source_source_id', ['source', 'source_id'])
@Index('IDX_source_created_at', ['source', 'created_at'])
export class TechTrend {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 50 })
  source!: string;

  @Column({ type: 'varchar', length: 100 })
  source_id!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'json' })
  short_summary!: string[];

  @Column({ type: 'text', nullable: true })
  long_summary!: string | null;

  @Column({ type: 'varchar', length: 512, unique: true })
  link_url!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index('IDX_technical_tags') 
  technical_tags!: string | null;

  // 원본 글 작성일자 (정렬용)
  @Column({ type: 'date' })
  created_at!: Date;

  // 시스템 수집 완료 시각
  @CreateDateColumn({ type: 'timestamp' })
  mined_at!: Date;
}