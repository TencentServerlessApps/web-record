import {spawn} from 'child_process';

const {logger} = require('common');

export function spawnFfmpeg(input: string | 'pipe:', output: string | 'pipe:', muxer: 'mp4' | 'hls', encryptArgs?: string[]) {
    const inputArgs = (input === 'pipe:') ? ['-f', 'webm', '-i', 'pipe:',] : ['-i', input];
    const mp4TranscodeArgs = [
        '-async', '1',
        '-c:a', 'libfdk_aac',
        '-profile:a', 'aac_he_v2',
        '-c:v', 'copy',
        '-threads', '0',
        '-max_muxing_queue_size', '2048',
        '-max_interleave_delta', '0'
    ];
    const hlsTranscodeArgs = [
        '-threads', '0',
        '-async', '1',
        '-c:v', 'copy',
        '-hls_time', '30',
        '-hls_list_size', '0'
    ];
    if (encryptArgs) {
        hlsTranscodeArgs.push(...encryptArgs);
    }
    const transcodeArgs = (muxer === 'mp4') ? mp4TranscodeArgs : hlsTranscodeArgs;
    // const outputArgs = (output === 'pipe:') ? ['-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:'] : [output];
    const outputArgs = (muxer === 'mp4') ? ((output === 'pipe:') ? ['-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:'] : ['-movflags', 'faststart', '-f', 'mp4', output]) : [output];
    const args = [
        ...inputArgs,
        ...transcodeArgs,
        ...outputArgs,
    ];

    logger.log('ffmpeg args:', args);
    const ffmpegProcess = spawn('ffmpeg', args);


    return ffmpegProcess;
}
