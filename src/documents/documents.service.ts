import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Document as DocumentEntity } from './schemas/document.schema';
import {
  UploadDocumentDto,
  AssociateDocumentDto,
} from './dto/upload-document.dto';
import { ExtractorFactory } from './extractors/extractor.factory';
import { UsersService } from '../users/users.service';
import { v4 as uuidv4 } from 'uuid';

type UploadedDocumentFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectModel(DocumentEntity.name)
    private documentModel: Model<DocumentEntity>,
    private extractorFactory: ExtractorFactory,
    private usersService: UsersService,
  ) {}

  async uploadDocument(
    file: UploadedDocumentFile,
    uploadDto: UploadDocumentDto,
    userId: string,
  ): Promise<DocumentEntity> {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    if (!this.extractorFactory.isSupportedMimetype(file.mimetype)) {
      throw new BadRequestException(
        `File type not supported. Supported types: ${this.extractorFactory
          .getSupportedMimetypes()
          .join(', ')}`,
      );
    }

    if (!uploadDto.organizationId) {
      throw new BadRequestException('organizationId is required');
    }

    try {
      const content = await this.extractorFactory.extractContent(
        file.buffer,
        file.mimetype,
      );

      const userDoc = await this.usersService.findByFirebaseUid(userId);
      if (!userDoc) {
        throw new BadRequestException('User not found');
      }

      const storageKey = `documents/${uploadDto.organizationId}/${uuidv4()}-${file.originalname}`;

      const document = new this.documentModel({
        name: file.originalname,
        originalName: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        organizationId: new Types.ObjectId(uploadDto.organizationId),
        eventId: uploadDto.eventId
          ? new Types.ObjectId(uploadDto.eventId)
          : undefined,
        moduleId: uploadDto.moduleId
          ? new Types.ObjectId(uploadDto.moduleId)
          : undefined,
        activityId: uploadDto.activityId
          ? new Types.ObjectId(uploadDto.activityId)
          : undefined,
        uploadedBy: userDoc._id,
        uploadedAt: new Date(),
        content,
        extractedAt: new Date(),
        url: storageKey,
        tags: uploadDto.tags || [],
      });

      const savedDocument = await document.save();

      this.logger.log(
        `Document uploaded successfully: ${savedDocument._id} (${file.originalname})`,
      );

      return savedDocument;
    } catch (error: any) {
      this.logger.error(
        `Error uploading document: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to upload document: ${error.message}`,
      );
    }
  }

  async getDocumentsByOrganization(
    organizationId: string,
    filters?: { eventId?: string; moduleId?: string; activityId?: string },
  ): Promise<DocumentEntity[]> {
    try {
      const query: any = {
        organizationId: new Types.ObjectId(organizationId),
        active: true,
      };

      if (filters?.eventId) {
        query.eventId = new Types.ObjectId(filters.eventId);
      }
      if (filters?.moduleId) {
        query.moduleId = new Types.ObjectId(filters.moduleId);
      }
      if (filters?.activityId) {
        query.activityId = new Types.ObjectId(filters.activityId);
      }

      return await this.documentModel
        .find(query)
        .populate('uploadedBy', 'names email')
        .sort({ uploadedAt: -1 })
        .exec();
    } catch (error: any) {
      this.logger.error(
        `Error retrieving documents: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async getDocumentById(documentId: string): Promise<DocumentEntity> {
    try {
      const document = await this.documentModel
        .findById(new Types.ObjectId(documentId))
        .populate('uploadedBy', 'names email')
        .exec();

      if (!document) {
        throw new NotFoundException(`Document not found: ${documentId}`);
      }

      return document;
    } catch (error: any) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(
        `Error retrieving document: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async associateDocument(
    documentId: string,
    associateDto: AssociateDocumentDto,
  ): Promise<DocumentEntity> {
    try {
      const updateData: any = {};

      if (associateDto.eventId) {
        updateData.eventId = new Types.ObjectId(associateDto.eventId);
      }
      if (associateDto.moduleId) {
        updateData.moduleId = new Types.ObjectId(associateDto.moduleId);
      }
      if (associateDto.activityId) {
        updateData.activityId = new Types.ObjectId(associateDto.activityId);
      }

      const document = await this.documentModel.findByIdAndUpdate(
        new Types.ObjectId(documentId),
        updateData,
        { new: true },
      );

      if (!document) {
        throw new NotFoundException(`Document not found: ${documentId}`);
      }

      this.logger.log(
        `Document associated successfully: ${documentId} to event/module/activity`,
      );

      return document;
    } catch (error: any) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(
        `Error associating document: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async deleteDocument(documentId: string): Promise<void> {
    try {
      const result = await this.documentModel.findByIdAndDelete(
        new Types.ObjectId(documentId),
      );

      if (!result) {
        throw new NotFoundException(`Document not found: ${documentId}`);
      }

      this.logger.log(`Document deleted: ${documentId}`);
    } catch (error: any) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(
        `Error deleting document: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async searchDocuments(
    organizationId: string,
    searchTerm: string,
  ): Promise<DocumentEntity[]> {
    try {
      return await this.documentModel
        .find({
          organizationId: new Types.ObjectId(organizationId),
          active: true,
          $or: [
            { name: { $regex: searchTerm, $options: 'i' } },
            { content: { $regex: searchTerm, $options: 'i' } },
            { tags: { $regex: searchTerm, $options: 'i' } },
          ],
        })
        .populate('uploadedBy', 'names email')
        .sort({ uploadedAt: -1 })
        .exec();
    } catch (error: any) {
      this.logger.error(
        `Error searching documents: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async getDocumentContent(documentId: string): Promise<string> {
    try {
      const document = await this.getDocumentById(documentId);
      return document.content;
    } catch (error: any) {
      this.logger.error(
        `Error retrieving document content: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
