import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('tbl_tech_trends')
@Index('IDX_source_created_at', ['source', 'created_at'])
export class TechTrend {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'varchar', length: 512, unique: true })
  link_url!: string;

  @Column({ type: 'json' })
  summary!: string[];

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index('IDX_technical_tags') 
  technical_tags!: string | null;

  @Column({ type: 'varchar', length: 50 })
  source!: string;

  // 원본 글 작성일자 (정렬용)
  @Column({ type: 'date' })
  created_at!: Date;

  // 시스템 수집 완료 시각
  @CreateDateColumn({ type: 'timestamp' })
  mined_at!: Date;
}