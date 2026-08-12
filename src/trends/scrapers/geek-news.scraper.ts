import { Injectable, Logger } from '@nestjs/common';
import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Article, ArticleDetails, IArticleScraper } from '../interfaces/scraper.interface';

@Injectable()
export class GeekNewsScraper implements IArticleScraper {
  private readonly logger = new Logger(GeekNewsScraper.name);
  private readonly GEEKNEWS_RSS_URL = 'https://news.hada.io/rss/news';
  private readonly GEEKNEWS_TOPIC_URL = 'https://news.hada.io/topic';
  private readonly HEADERS = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  public readonly sourceName = 'geeknews';

  private parser: Parser;

  constructor() {
    this.parser = new Parser({
      headers: this.HEADERS,
    });
  }

  // ID 추출하는 함수
  private extractTopicId(urlOrId: string): string {
    const match = urlOrId.match(/id=(\d+)/);
    return match && match[1] ? match[1] : urlOrId;
  }

  // 최신 아티클 목록 수집 (RSS 사용)
  async getArticles(): Promise<Article[]> {
    try {
      this.logger.log(`[Scraper:GeekNews] 아티클 목록 수집 시작 | url=${this.GEEKNEWS_RSS_URL}`);

      const feed = await this.parser.parseURL(this.GEEKNEWS_RSS_URL);

      if (!feed.items || feed.items.length === 0) {
        this.logger.warn(`[Scraper:GeekNews] 수집된 아티클 항목이 없습니다.`);
        return [];
      }

      const articles: Article[] = feed.items.map((item) => {
        const rawLink = item.link || item.id || '';
        const topicId = this.extractTopicId(rawLink);
        const pubDate = item.pubDate || item.isoDate || '';

        return {
          id: topicId,
          title: item.title?.trim() || '제목 없음',
          url: rawLink,
          created_at: pubDate ? new Date(pubDate).toISOString().split('T')[0] : '',
          source: this.sourceName,
        };
      });

      this.logger.log(`[Scraper:GeekNews] 아티클 목록 수집 완료 | total=${articles.length}`);
      return articles;

    } catch (error: any) {
      this.logger.error(`[Scraper:GeekNews] 아티클 목록 수집 실패 | error=${error.message}`);
      return [];
    }
  }

  // 게시글 ID의 본문 및 통계 정보 수집
  async getArticleDetails(articleId: string): Promise<ArticleDetails | null> {
    try {
      const targetUrl = `${this.GEEKNEWS_TOPIC_URL}?id=${articleId}`;

      const response = await axios.get(targetUrl, {
        headers: this.HEADERS,
        timeout: 5000,
      });
      if (!response.data) return null;

      const $ = cheerio.load(response.data);

      const content = $('.topic_contents, .topic_desc').text().trim();
      if (!content) return null;

      // 페이지 전체 텍스트에서 포인트/댓글 수 추출
      const pageText = $('body').text().replace(/\s+/g, ' ').trim();
      const points = this.extractPoints(pageText);
      const commentCount = this.extractCommentCount(pageText);

      return {
        content,
        like_count: points,
        comment_count: commentCount,
      };
    } catch (error: any) {
      this.logger.warn(
        `[Scraper:GeekNews] 아티클 본문 수집 실패 | articleId=${articleId}, error=${error.message}`,
      );
      return null;
    }
  }

  // 포인트 추출
  private extractPoints(pageText: string): number {
    const match = pageText.match(/(\d+)\s*P\s+by\s+GN\+?/i);
    return match ? Number(match[1]) : 0;
  }

  // 댓글 수 추출
  private extractCommentCount(pageText: string): number {
    const match = pageText.match(/댓글\s*(\d+)\s*개/);
    return match ? Number(match[1]) : 0;
  }
}