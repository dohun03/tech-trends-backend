import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class GetTrendsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page는 정수여야 합니다.' })
  @Min(1, { message: 'page는 최소 1 이상이어야 합니다.' })
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit는 정수여야 합니다.' })
  @Min(1, { message: 'limit는 최소 1 이상이어야 합니다.' })
  @Max(100, { message: 'limit는 최대 100까지 설정할 수 있습니다.' })
  limit?: number = 5;

  @IsOptional()
  @IsString()
  search?: string = '';

  @IsOptional()
  @IsString()
  source?: string = 'ALL';

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isNew?: boolean = false;

  @IsOptional()
  @IsIn(['ASC', 'DESC'], { message: 'sort는 ASC 또는 DESC만 허용됩니다.' })
  sort?: 'ASC' | 'DESC' = 'DESC';
}