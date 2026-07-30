import { Injectable, Logger } from '@nestjs/common';
import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { BaseArticle, IArticleScraper } from '../interfaces/scraper.interface';

@Injectable()
export class GeekNewsScraper implements IArticleScraper {
  private readonly logger = new Logger(GeekNewsScraper.name);
  private readonly GEEKNEWS_RSS_URL = 'https://news.hada.io/rss/news';
  private readonly GEEKNEWS_TOPIC_URL = 'https://news.hada.io/topic';
  
  private readonly HEADERS = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  private parser: Parser;
  public readonly sourceName = 'geeknews';

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
  async getTrendingArticles(): Promise<BaseArticle[]> {
    try {
      this.logger.log(`[Scraper:GeekNews] 아티클 목록 수집 시작 | url=${this.GEEKNEWS_RSS_URL}`);

      const feed = await this.parser.parseURL(this.GEEKNEWS_RSS_URL);

      if (!feed.items || feed.items.length === 0) {
        this.logger.warn(`[Scraper:GeekNews] 수집된 아티클 항목이 없습니다.`);
        return [];
      }

      const articles: BaseArticle[] = feed.items.map((item) => {
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

  // 게시글 ID의 본문 스크래핑 (HTML 파싱)
  async getArticleContent(articleId: string): Promise<string | null> {
    try {
      const targetUrl = `${this.GEEKNEWS_TOPIC_URL}?id=${articleId}`;

      const response = await axios.get(targetUrl, {
        headers: this.HEADERS,
        timeout: 5000,
      });
      if (!response.data) return null;

      const $ = cheerio.load(response.data);
      const contentElement = $('.topic_contents, .topic_desc');
      if (contentElement.length === 0) {
        this.logger.warn(`[Scraper:GeekNews] 본문 태그를 찾을 수 없음 | articleId=${articleId}`);
        return null;
      }

      const fullContent = contentElement.text().trim();
      return fullContent || null;

    } catch (error: any) {
      this.logger.warn(`[Scraper:GeekNews] 아티클 본문 수집 실패 | articleId=${articleId}, error=${error.message}`);
      return null;
    }
  }
}