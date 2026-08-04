import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  IconButton,
  Typography,
  FormHelperText,
} from '@mui/material';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import CloseIcon from '@mui/icons-material/Close';
import { useChatStore } from '../store/chatStore';

// 暗色主题：让对话框内 MUI 组件在暗背景上显示浅色文字
const darkTheme = createTheme({ palette: { mode: 'dark' } });

/**
 * 设置页（P1）：
 * - 展示连接状态与当前头像模式
 * - 展示 FlashHead 推理状态（仅本地推理，由后端启动时探测决定，无需选择）
 * - 上传人像图并通过 /avatar 上报给后端
 */
export default function Settings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const avatarMode = useChatStore((s) => s.avatarMode);
  const connected = useChatStore((s) => s.connected);
  const phase = useChatStore((s) => s.phase);
  const [portrait, setPortrait] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setPortrait(reader.result as string);
    reader.readAsDataURL(f);
  };

  const sendPortrait = () => {
    if (!portrait) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/avatar`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'portrait', image: portrait }));
      ws.close();
    };
  };

  return (
    <ThemeProvider theme={darkTheme}>
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth="xs"
        fullWidth
        PaperProps={{ className: '!bg-slate-900/95 !backdrop-blur-md !text-white' }}
      >
        <DialogTitle className="!text-white">设置</DialogTitle>
        <DialogContent>
        <Typography variant="body2" className="mb-3 text-slate-500">
          连接状态：
          {phase === 'chatting' ? '已连接小智' : connected ? '连接中…' : '未连接'}
          ｜ 头像模式：{avatarMode}
        </Typography>

        <Typography variant="body2" className="mb-1 text-slate-300">
          FlashHead 推理：本地推理（Gradio）
        </Typography>
        <Typography variant="caption" className="mb-3 block text-slate-400">
          数字人由后端连接本地 SoulX FlashHead 服务（FLASHHEAD_URL，默认
          http://127.0.0.1:6006）驱动；启动时自动探测，连不上则直接实时播放语音，无需在此选择模式。
        </Typography>

        {/* 人像图上传：用带标签的按钮（可访问性），并显示已选文件名与移除入口 */}
        <Box className="mt-3">
          <Button
            variant="outlined"
            component="label"
            startIcon={<UploadFileIcon />}
            sx={{ minHeight: 44 }}
          >
            选择人像图
            <input hidden accept="image/*" type="file" onChange={onFile} />
          </Button>

          {fileName && (
            <Box className="mt-2 flex items-center justify-between gap-2 rounded bg-white/5 px-3 py-2">
              <Typography
                variant="body2"
                className="truncate text-slate-200"
                title={fileName}
              >
                {fileName}
              </Typography>
              <IconButton
                size="small"
                aria-label="移除已选人像图"
                onClick={() => {
                  setPortrait('');
                  setFileName('');
                }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          )}

          <FormHelperText className="text-slate-400">
            支持 JPG / PNG，将作为数字人人像上报给后端。
          </FormHelperText>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
        <Button
          variant="contained"
          disabled={!portrait}
          onClick={() => {
            sendPortrait();
            onClose();
          }}
        >
          保存人像
        </Button>
      </DialogActions>
      </Dialog>
    </ThemeProvider>
  );
}
