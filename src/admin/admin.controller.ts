import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Query,
  Body,
  Sse,
  UseGuards,
  Logger,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { AdminService, DashboardMetrics, SessionActivityDay, HistoricalUsageData, UserListItem, SessionStatusItem } from './admin.service';
import { SystemAdminGuard } from '../auth/guards/system-admin.guard';
import { ServerMetrics } from './services/server-metrics.service';
import { CapacityService, CapacityMeasurementView } from './services/capacity.service';
import { RecordCapacityDto } from './dto/capacity.dto';

interface MessageEvent {
  data: string;
  id?: string;
  type?: string;
  retry?: number;
}

interface ToggleAdminDto {
  isAdmin: boolean;
}

/**
 * AdminController - System Administration Endpoints
 *
 * All endpoints require system admin privileges (isSystemAdmin flag).
 * Provides dashboard metrics, server monitoring, and user management.
 */
@Controller('admin')
@UseGuards(SystemAdminGuard)
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly adminService: AdminService,
    private readonly capacityService: CapacityService,
  ) {}

  /**
   * GET /admin/dashboard
   * Get current dashboard metrics snapshot
   */
  @Get('dashboard')
  async getDashboard(): Promise<DashboardMetrics> {
    this.logger.log('Getting dashboard metrics');
    return this.adminService.getDashboardMetrics();
  }

  /**
   * GET /admin/dashboard/stream
   * SSE stream for real-time dashboard updates (3s interval)
   */
  @Sse('dashboard/stream')
  streamDashboard(): Observable<MessageEvent> {
    this.logger.log('SSE connection opened for dashboard metrics');
    return this.adminService.getDashboardStream();
  }

  /**
   * GET /admin/sessions
   * Get all sessions with their current status
   */
  @Get('sessions')
  async getAllSessions(): Promise<SessionStatusItem[]> {
    this.logger.log('Getting all sessions');
    return this.adminService.getAllSessions();
  }

  /**
   * GET /admin/sessions/activity
   * Get session activity data for 90-day grid visualization
   */
  @Get('sessions/activity')
  async getSessionActivity(): Promise<SessionActivityDay[]> {
    this.logger.log('Getting session activity data');
    return this.adminService.getSessionActivity();
  }

  /**
   * GET /admin/server-metrics
   * Get current server performance metrics
   */
  @Get('server-metrics')
  async getServerMetrics(): Promise<ServerMetrics> {
    this.logger.log('Getting server metrics');
    return this.adminService.getServerMetrics();
  }

  /**
   * GET /admin/server-metrics/stream
   * SSE stream for real-time server metrics (2s interval)
   */
  @Sse('server-metrics/stream')
  streamServerMetrics(): Observable<MessageEvent> {
    this.logger.log('SSE connection opened for server metrics');
    return this.adminService.getServerMetricsStream();
  }

  /**
   * GET /admin/usage/history
   * Get historical usage data for bar charts
   * @param days - Number of days to fetch (7, 30, or 90)
   */
  @Get('usage/history')
  async getUsageHistory(
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
  ): Promise<HistoricalUsageData[]> {
    this.logger.log(`Getting usage history for ${days} days`);
    return this.adminService.getUsageHistory(days);
  }

  /**
   * GET /admin/capacity
   * Measured voice capacity: the newest load-test result for each
   * environment + GPU pair.
   */
  @Get('capacity')
  async getCapacity(): Promise<CapacityMeasurementView[]> {
    return this.capacityService.latest();
  }

  /**
   * POST /admin/capacity
   * Record a finished load-test run (scripts/load-test/load_test.py --publish-url).
   */
  @Post('capacity')
  async recordCapacity(@Body() body: RecordCapacityDto): Promise<CapacityMeasurementView> {
    this.logger.log(
      `Recording capacity: ${body.maxSessions} sessions on ${body.gpuName} (${body.environment})`,
    );
    return this.capacityService.record(body);
  }

  /**
   * GET /admin/users
   * List all users with pagination
   */
  @Get('users')
  async listUsers(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ): Promise<{
    users: UserListItem[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    this.logger.log(`Listing users (page ${page}, limit ${limit})`);
    return this.adminService.listUsers(page, limit);
  }

  /**
   * PATCH /admin/users/:id/verify
   * Verify a user account
   */
  @Patch('users/:id/verify')
  async verifyUser(@Param('id') userId: string): Promise<UserListItem> {
    this.logger.log(`Verifying user ${userId}`);
    return this.adminService.verifyUser(userId);
  }

  /**
   * PATCH /admin/users/:id/admin
   * Toggle system admin status for a user
   */
  @Patch('users/:id/admin')
  async toggleAdminStatus(
    @Param('id') userId: string,
    @Body() body: ToggleAdminDto,
  ): Promise<UserListItem> {
    this.logger.log(`Setting admin status for user ${userId} to ${body.isAdmin}`);
    return this.adminService.toggleAdminStatus(userId, body.isAdmin);
  }
}
