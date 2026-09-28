import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { SignupDto } from './dto/signup.dto.js';
import { LoginDto } from './dto/login.dto.js';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async signup(signupDto: SignupDto) {
    console.log('🔍 [SIGNUP] Starting signup process for:', signupDto.email);

    try {
      // Check if user already exists
      console.log('🔍 [SIGNUP] Checking if user exists...');
      const existingUser = await this.prisma.user.findUnique({
        where: { email: signupDto.email },
      });
      console.log('🔍 [SIGNUP] Existing user check complete:', !!existingUser);

      if (existingUser) {
        console.log('❌ [SIGNUP] User already exists');
        throw new ConflictException('User with this email already exists');
      }

      // Hash password
      console.log('🔍 [SIGNUP] Hashing password...');
      const hashedPassword = await bcrypt.hash(signupDto.password, 12);
      console.log('🔍 [SIGNUP] Password hashed successfully');

      // Create user with verified=false (default)
      console.log('🔍 [SIGNUP] Creating user in database...');
      const user = await this.prisma.user.create({
        data: {
          email: signupDto.email,
          password: hashedPassword,
          name: signupDto.name,
        },
        select: {
          id: true,
          email: true,
          name: true,
          verified: true,
          createdAt: true,
        },
      });
      console.log('✅ [SIGNUP] User created successfully:', user.id);

      // Return user without token - account needs verification
      return {
        user,
        message: 'Signup successful. Please contact your administrator for account approval.',
        verified: user.verified,
      };
    } catch (error) {
      console.error('❌ [SIGNUP] Error occurred:', error);
      throw error;
    }
  }

  async login(loginDto: LoginDto) {
    // Find user
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(
      loginDto.password,
      user.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check if user is verified
    if (!user.verified) {
      throw new UnauthorizedException('Your account is pending administrator approval. Please contact your administrator.');
    }

    // Generate JWT token
    const token = this.generateToken(user.id, user.email);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        verified: true, // User can only login if verified
        createdAt: user.createdAt,
      },
      token,
    };
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        verified: true,
        isSystemAdmin: true,
        createdAt: true,
        projectMemberships: {
          select: {
            id: true,
            projectId: true,
            role: true,
            project: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }

  private generateToken(userId: string, email: string): string {
    const payload = {
      sub: userId,
      email,
    };

    return this.jwtService.sign(payload);
  }

  /**
   * Generate JWT token for a participant
   * @param participantId - Participant database ID
   * @param sessionId - Session ID the participant belongs to
   * @returns JWT token
   */
  generateParticipantToken(participantId: string, sessionId: string): string {
    const payload = {
      sub: participantId,
      sessionId,
      type: 'participant',
    };

    return this.jwtService.sign(payload);
  }
}
