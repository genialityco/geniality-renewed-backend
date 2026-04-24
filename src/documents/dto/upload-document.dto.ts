export class UploadDocumentDto {
  organizationId: string;
  eventId?: string;
  moduleId?: string;
  activityId?: string;
  tags?: string[];
}

export class AssociateDocumentDto {
  eventId?: string;
  moduleId?: string;
  activityId?: string;
}
