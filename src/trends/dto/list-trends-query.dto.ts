import { IsIn, IsOptional } from 'class-validator';
import { BaseTrendsQueryDto } from './base-trends-query.dto';

export class ListTrendsQueryDto extends BaseTrendsQueryDto {
  @IsOptional()
  @IsIn(['ASC', 'DESC'], { message: 'sort는 ASC 또는 DESC만 허용됩니다.' })
  sort?: 'ASC' | 'DESC' = 'DESC';
}