export interface Cos {
    Bucket?: string;
    Region?: string;
    TargetDir?: string;
    TargetName?:string;
}

export interface Vod {
    MediaInfo?: MediaInfo;
    ProcedureInfo?: ProcedureInfo;
    SubAppId?: number;
}

export interface MediaInfo {
    MediaName?: string;
    ExpireTime?: string;
    StorageRegion?: string;
    ClassId?: number;
    SourceContext?: string;
}

export interface ProcedureInfo {
    Procedure?: string;
    SessionContext?: string;
}

export interface OutputVideoInfo {
    Muxer: 'hls' | 'mp4';
    EncryptKey: string;
    EncryptIv: string;
    AuthUrl: string;
}

export interface TaskInfo {
    TaskID?: string;
    StorageType?: 'cfs' | 'cos';
    Param?: {
        Output?: {
            Cos?: Cos,
            Vod?: Vod,
            Video?: OutputVideoInfo;
        }
        StorageType?: 'cfs' | 'cos';
        RecordURL?: string;
        CallbackURL?: string;
        MaxDurationLimit?: number;
    };

    Status?: "recording" | "transcode";
    InvokedRequestID?: string;
    CreateTime?: number;

    StartTime?: number;
    StopTime?: number;
    CancelTime?: number;
}

export interface TranscodeEvent {
    TaskID: string;
    Force?: boolean;

}