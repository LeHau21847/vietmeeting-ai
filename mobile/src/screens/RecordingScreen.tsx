/**
 * src/screens/RecordingScreen.tsx
 *
 * AI Studio Workspace – VietMeeting AI
 * Modern SaaS Dashboard with real-time progress tracking, live transcript,
 * responsive 2-column layout (Web) / 1-column (Mobile)
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Clipboard,
  Easing,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Audio } from "expo-av";
import axios, { AxiosError } from "axios";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";

import {
  API_ENDPOINTS,
  API_TIMEOUT_MS,
  API_TIMEOUT_SHORT_MS,
  BASE_URL,
  PROGRESS_POLL_INTERVAL_MS,
} from "@/constants/api";
import { AIEngineBadge, AIConfigModal } from "@/components/AIConfigModal";
import {
  AIProcessingResult,
  AIRewriteBody,
  AIRewriteMode,
  APIErrorResponse,
  ExtractedTask,
  FontFamilyType,
  MeetingRead,
  PaperThemeType,
  ProgressData,
  RecordingScreenState,
  RootStackParamList,
  TextAlignType,
} from "@/types/meeting";

// ---------------------------------------------------------------------------
// Types & Options
// ---------------------------------------------------------------------------
type NavProp = NativeStackNavigationProp<RootStackParamList, "Recording">;
type RouteProps = RouteProp<RootStackParamList, "Recording">;

const RECORDING_OPTIONS: Audio.RecordingOptions = {
  android: {
    extension: ".wav",
    outputFormat: Audio.AndroidOutputFormat.DEFAULT,
    audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  ios: {
    extension: ".wav",
    outputFormat: Audio.IOSOutputFormat.LINEARPCM,
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 128000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: "audio/webm",
    bitsPerSecond: 128000,
  },
};

// ===========================================================================
// COMPONENT CHÍNH: RecordingScreen
// ===========================================================================
export default function RecordingScreen(): React.JSX.Element {
  const navigation = useNavigation<NavProp>();
  const route = useRoute<RouteProps>();
  const { meetingId, meetingTitle, meetingStatus } = route.params;

  // Screen State
  const [screenState, setScreenState] = useState<RecordingScreenState>("idle");
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [result, setResult] = useState<AIProcessingResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [errorDetail, setErrorDetail] = useState<string>("");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Upload file info
  const [selectedFileName, setSelectedFileName] = useState<string>("");
  const [selectedFileSize, setSelectedFileSize] = useState<string>("");

  // Progress tracking
  const [progressData, setProgressData] = useState<ProgressData | null>(null);
  const progressPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Active Result Tab: "minutes" | "tasks" | "transcript"
  const [activeTab, setActiveTab] = useState<"minutes" | "tasks" | "transcript">("minutes");

  // Modal cấu hình AI
  const [aiConfigModalVisible, setAiConfigModalVisible] = useState(false);

  // Refs
  const recordingRef = useRef<Audio.Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Animations
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const dotAnim = useRef(new Animated.Value(1)).current;

  // Pulse animation for recording
  const startPulse = useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.18, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();
  }, [pulseAnim]);

  const stopPulse = useCallback(() => {
    pulseAnim.stopAnimation();
    Animated.timing(pulseAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  }, [pulseAnim]);

  const startDotBlink = useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(dotAnim, { toValue: 0.2, duration: 500, useNativeDriver: true }),
        Animated.timing(dotAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      ])
    ).start();
  }, [dotAnim]);

  const animateResultIn = useCallback(() => {
    fadeAnim.setValue(0);
    slideAnim.setValue(30);
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, slideAnim]);

  // -------------------------------------------------------------------------
  // Progress Polling
  // -------------------------------------------------------------------------
  const startProgressPolling = useCallback(() => {
    stopProgressPolling();
    progressPollRef.current = setInterval(async () => {
      try {
        const res = await axios.get<ProgressData>(
          API_ENDPOINTS.getProgress(meetingId),
          { timeout: 5000 }
        );
        setProgressData(res.data);

        // If completed or failed, stop polling
        if (res.data.status === "completed" || res.data.status === "failed") {
          stopProgressPolling();
        }
      } catch {
        // Silently ignore polling errors
      }
    }, PROGRESS_POLL_INTERVAL_MS);
  }, [meetingId]);

  const stopProgressPolling = useCallback(() => {
    if (progressPollRef.current) {
      clearInterval(progressPollRef.current);
      progressPollRef.current = null;
    }
  }, []);

  // Load history if meeting is already completed
  useEffect(() => {
    if (meetingStatus === "completed") {
      loadMeetingHistory();
    } else if (meetingStatus === "processing") {
      setScreenState("processing");
      startProgressPolling();
    } else {
      requestMicrophonePermission();
    }
    return () => {
      cleanupRecording();
      stopProgressPolling();
    };
  }, []);

  const loadMeetingHistory = async (): Promise<void> => {
    setIsLoadingHistory(true);
    try {
      const response = await axios.get<MeetingRead>(
        API_ENDPOINTS.getMeeting(meetingId),
        { timeout: API_TIMEOUT_SHORT_MS }
      );
      const meeting = response.data;
      const syntheticResult: AIProcessingResult = {
        meeting_id: meeting.id,
        audio_file_url: meeting.audio_file_url ?? "",
        raw_transcript: meeting.raw_transcript ?? "",
        minutes: meeting.final_minutes ?? "",
        tasks: (meeting.tasks ?? []).map((t) => ({
          title: t.title,
          description: t.description ?? null,
          assignee_name: null,
          due_date: null,
          id: t.id,
          status: t.status,
        })),
        processing_metadata: {},
      };
      setResult(syntheticResult);
      setScreenState("success");
      animateResultIn();
    } catch {
      setErrorMessage("Không thể tải lại kết quả cuộc họp.");
      setErrorDetail("Kiểm tra kết nối Backend và thử lại.");
      setScreenState("error");
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const requestMicrophonePermission = async (): Promise<void> => {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      const { status } = await Audio.requestPermissionsAsync();
      const granted = status === "granted";
      setHasPermission(granted);
      if (!granted && Platform.OS !== "web") {
        Alert.alert(
          "⚠️ Cần quyền Microphone",
          "VietMeeting AI cần quyền Microphone để ghi âm trực tiếp.\nBạn cũng có thể tải file audio có sẵn.",
          [
            { text: "Bỏ qua", style: "cancel" },
            { text: "Mở Cài đặt", onPress: () => Linking.openSettings() },
          ]
        );
      }
    } catch (error) {
      console.error("[RecordingScreen] Lỗi xin quyền mic:", error);
      setHasPermission(false);
    }
  };

  const startTimer = useCallback((): void => {
    setElapsedSeconds(0);
    timerRef.current = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
  }, []);

  const stopTimer = useCallback((): void => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cleanupRecording = useCallback(async (): Promise<void> => {
    stopTimer();
    if (recordingRef.current) {
      try {
        const status = await recordingRef.current.getStatusAsync();
        if (status.isRecording) {
          await recordingRef.current.stopAndUnloadAsync();
        }
      } catch { /* bỏ qua */ }
      recordingRef.current = null;
    }
  }, [stopTimer]);

  const formattedTime = useMemo((): string => {
    const hours = Math.floor(elapsedSeconds / 3600);
    const minutes = Math.floor((elapsedSeconds % 3600) / 60);
    const seconds = elapsedSeconds % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    if (hours > 0) {
      return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${pad(minutes)}:${pad(seconds)}`;
  }, [elapsedSeconds]);

  // Start recording
  const handleStartRecording = async (): Promise<void> => {
    setResult(null);
    setErrorMessage("");
    setErrorDetail("");
    setProgressData(null);
    if (!hasPermission) {
      await requestMicrophonePermission();
      return;
    }
    try {
      const { recording } = await Audio.Recording.createAsync(
        RECORDING_OPTIONS,
        (_status: any) => {},
        100
      );
      recordingRef.current = recording;
      setScreenState("recording");
      startTimer();
      startPulse();
      startDotBlink();
    } catch (error) {
      let message = "Không thể bắt đầu ghi âm.";
      if (error instanceof Error) {
        message = error.message.includes("permission")
          ? "Quyền Microphone bị từ chối."
          : `Lỗi: ${error.message}`;
      }
      setErrorMessage(message);
      setErrorDetail("Kiểm tra quyền truy cập Microphone và thử lại.");
      setScreenState("error");
    }
  };

  // Stop recording
  const handleStopRecording = async (): Promise<void> => {
    if (!recordingRef.current) return;
    stopTimer();
    stopPulse();
    dotAnim.stopAnimation();
    setScreenState("processing");
    startProgressPolling();

    let audioUri: string | null = null;
    try {
      await recordingRef.current.stopAndUnloadAsync();
      audioUri = recordingRef.current.getURI();
      recordingRef.current = null;
      if (!audioUri) throw new Error("Không lấy được URI file ghi âm.");
    } catch (error) {
      setErrorMessage("Không thể lưu file ghi âm.");
      setErrorDetail(error instanceof Error ? error.message : String(error));
      setScreenState("error");
      stopProgressPolling();
      return;
    }
    await uploadAudioToAPI(audioUri, "recording.webm");
  };

  // File Picker
  const handlePickFile = async (): Promise<void> => {
    if (Platform.OS === "web") {
      if (!fileInputRef.current) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "audio/*,.wav,.mp3,.m4a,.webm,.ogg,.mp4,.flac";
        input.style.display = "none";
        document.body.appendChild(input);
        fileInputRef.current = input;
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) return;

          // Show file info
          setSelectedFileName(file.name);
          setSelectedFileSize(`${(file.size / (1024 * 1024)).toFixed(1)} MB`);

          setResult(null);
          setErrorMessage("");
          setErrorDetail("");
          setProgressData(null);
          setScreenState("processing");
          startProgressPolling();

          try {
            const formData = new FormData();
            formData.append("file", file, file.name);
            const endpoint = API_ENDPOINTS.processAudio(meetingId);
            const response = await axios.post<AIProcessingResult>(endpoint, formData, {
              timeout: API_TIMEOUT_MS,
            });
            stopProgressPolling();
            setResult(response.data);
            setScreenState("success");
            animateResultIn();
          } catch (err) {
            stopProgressPolling();
            handleUploadError(err);
          }
          input.value = "";
        };
      }
      fileInputRef.current.click();
    } else {
      Alert.alert(
        "Tải file audio",
        "Trên điện thoại, vui lòng dùng tính năng Ghi âm trực tiếp hoặc cài expo-document-picker.",
        [{ text: "Đã hiểu" }]
      );
    }
  };

  // Upload to API
  const uploadAudioToAPI = async (audioUri: string, filename: string): Promise<void> => {
    try {
      const formData = new FormData();

      if (Platform.OS === "web") {
        const blobResponse = await fetch(audioUri);
        const blob = await blobResponse.blob();
        const ext = blob.type.includes("ogg") ? "recording.ogg" : "recording.webm";
        formData.append("file", blob, filename || ext);
      } else {
        formData.append("file", {
          uri: audioUri,
          name: filename || "recording.wav",
          type: "audio/wav",
        } as unknown as Blob);
      }

      const endpoint = API_ENDPOINTS.processAudio(meetingId);
      const response = await axios.post<AIProcessingResult>(endpoint, formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: API_TIMEOUT_MS,
      });

      stopProgressPolling();
      setResult(response.data);
      setScreenState("success");
      animateResultIn();
    } catch (error) {
      stopProgressPolling();
      handleUploadError(error);
    }
  };

  const handleUploadError = (error: unknown) => {
    console.error("[RecordingScreen] Lỗi upload:", error);
    let userMessage = "Không thể kết nối đến server AI.";
    let detail = "";

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<APIErrorResponse>;
      if (axiosError.code === "ECONNABORTED") {
        userMessage = "AI xử lý quá thời gian quy định (Timeout).";
        detail = "File ghi âm có thể quá dài. Hãy thử với đoạn ghi ngắn hơn.";
      } else if (axiosError.code === "ECONNREFUSED" || axiosError.message.includes("Network Error")) {
        userMessage = "Mất kết nối với Backend Local AI.";
        detail = "Đảm bảo FastAPI và Ollama (Qwen2.5) đang hoạt động ổn định.";
      } else if (axiosError.response) {
        const statusCode = axiosError.response.status;
        const resData = axiosError.response.data as any;

        let serverMessage = "";
        let serverDetail = "";

        if (resData) {
          if (typeof resData === "string") {
            serverMessage = resData;
          } else if (typeof resData.detail === "object" && resData.detail !== null) {
            serverMessage = resData.detail.message || resData.detail.error || "";
            serverDetail = resData.detail.detail || "";
          } else if (typeof resData.detail === "string") {
            serverMessage = resData.detail;
          } else if (resData.message) {
            serverMessage = resData.message;
            serverDetail = typeof resData.detail === "string" ? resData.detail : "";
          }
        }

        switch (statusCode) {
          case 400:
            userMessage = serverMessage || "Định dạng file không được hỗ trợ.";
            detail = serverDetail || "Hãy thử định dạng .wav, .mp3, .m4a, .webm.";
            break;
          case 404:
            userMessage = serverMessage || `Không tìm thấy cuộc họp ID #${meetingId}.`;
            detail = serverDetail || "Vui lòng quay lại trang chủ và tạo cuộc họp mới.";
            break;
          case 422:
            userMessage = serverMessage || "Không nhận diện được giọng nói trong âm thanh.";
            detail = serverDetail || "File audio quá nhỏ hoặc âm thanh bị rè, không có tiếng nói rõ ràng.";
            break;
          case 503:
            userMessage = serverMessage || "Dịch vụ AI tạm thời không khả dụng (HTTP 503).";
            detail = serverDetail || "Vui lòng kiểm tra tiến trình Whisper hoặc GPU.";
            break;
          default:
            userMessage = serverMessage || `Lỗi hệ thống (HTTP ${statusCode}).`;
            detail = serverDetail || axiosError.message;
        }
      }
    } else if (error instanceof Error) {
      userMessage = error.message;
    }

    setErrorMessage(userMessage);
    setErrorDetail(detail);
    setScreenState("error");
  };

  const handleReset = (): void => {
    setScreenState("idle");
    setResult(null);
    setErrorMessage("");
    setErrorDetail("");
    setElapsedSeconds(0);
    setProgressData(null);
    setSelectedFileName("");
    setSelectedFileSize("");
    stopProgressPolling();
  };

  // -------------------------------------------------------------------------
  // Loading History View
  // -------------------------------------------------------------------------
  if (isLoadingHistory) {
    return (
      <SafeAreaView style={s.loadingContainer}>
        <ActivityIndicator size="large" color="#6366f1" />
        <Text style={s.loadingText}>Đang tải biên bản cuộc họp...</Text>
      </SafeAreaView>
    );
  }

  // -------------------------------------------------------------------------
  // Main Render
  // -------------------------------------------------------------------------
  return (
    <SafeAreaView style={s.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#090D16" />
      <View style={s.mainContainer}>

        {/* ================================================================
            TOP NAVIGATION BAR
        ================================================================ */}
        <View style={s.navBar}>
          <View style={s.navLeft}>
            <Pressable
              onPress={() => navigation.goBack()}
              style={({ pressed }) => [s.backButton, pressed && s.btnPressed]}
            >
              <Ionicons name="arrow-back" size={20} color="#94a3b8" />
            </Pressable>
            <View style={s.navTitleBox}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={s.navTitle} numberOfLines={1}>
                  {meetingTitle}
                </Text>
                <View style={s.idBadge}>
                  <Text style={s.idBadgeText}>#{meetingId}</Text>
                </View>
              </View>
              <Text style={s.navSubtitle}>
                {meetingStatus === "completed" || screenState === "success"
                  ? "Biên bản & Nhiệm vụ đã hoàn tất"
                  : "AI Studio – Ghi âm & Phân tích Local AI"}
              </Text>
            </View>
          </View>

          <View style={s.navRight}>
            {/* Huy hiệu AI Engine (Gemini / Local) */}
            <AIEngineBadge onPress={() => setAiConfigModalVisible(true)} />

            <View style={[
              s.statusPill,
              screenState === "recording" && s.statusPillRec,
              screenState === "processing" && s.statusPillProc,
              screenState === "success" && s.statusPillDone,
            ]}>
              <View style={[
                s.statusDot,
                screenState === "recording" && { backgroundColor: "#f87171" },
                screenState === "processing" && { backgroundColor: "#fbbf24" },
                screenState === "success" && { backgroundColor: "#34d399" },
              ]} />
              <Text style={s.statusPillText}>
                {screenState === "recording"
                  ? "Đang ghi âm"
                  : screenState === "processing"
                  ? "AI đang xử lý"
                  : screenState === "success"
                  ? "Đã hoàn thành"
                  : "Sẵn sàng"}
              </Text>
            </View>
          </View>
        </View>

        {/* ================================================================
            BODY CONTENT
        ================================================================ */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={s.grid}>

            {/* ── CỘT TRÁI: Bảng điều khiển ghi âm ── */}
            <View style={s.leftCol}>
              <View style={s.controlCard}>

                {/* Status indicator row */}
                <View style={s.heroRow}>
                  <Animated.View style={{
                    width: 8, height: 8, borderRadius: 4,
                    backgroundColor: screenState === "recording" ? "#f87171" : "#6366f1",
                    opacity: screenState === "recording" ? dotAnim : 1,
                  }} />
                  <Text style={[
                    s.heroLabel,
                    screenState === "recording" && { color: "#f87171" }
                  ]}>
                    {screenState === "recording" ? "ĐANG THU ÂM TRỰC TIẾP" : "THIẾT BỊ SẴN SÀNG"}
                  </Text>
                </View>

                {/* Big Digital Timer */}
                <Text style={[
                  s.timerText,
                  screenState === "recording" && s.timerActive
                ]}>
                  {formattedTime}
                </Text>
                <Text style={s.timerHint}>
                  {screenState === "recording" ? "Nhấn nút đỏ để kết thúc và gửi AI" : "Nhấn Micro hoặc Tải file audio"}
                </Text>

                {/* Record Button with glowing ripple */}
                <View style={s.micWrap}>
                  {screenState === "recording" && (
                    <Animated.View style={[
                      s.micPulse,
                      { transform: [{ scale: pulseAnim }] }
                    ]} />
                  )}
                  <View style={[
                    s.micAura,
                    screenState === "recording" && s.micAuraActive
                  ]} />
                  <Pressable
                    onPress={screenState === "recording" ? handleStopRecording : handleStartRecording}
                    style={({ pressed }) => [
                      s.micBtn,
                      screenState === "recording" && s.micBtnActive,
                      pressed && s.btnPressed,
                    ]}
                  >
                    <Ionicons
                      name={screenState === "recording" ? "stop" : "mic"}
                      size={46}
                      color="#ffffff"
                    />
                  </Pressable>
                </View>

                {/* Action CTA Button */}
                <Pressable
                  onPress={screenState === "recording" ? handleStopRecording : handleStartRecording}
                  style={({ pressed }) => [
                    s.recActionBtn,
                    screenState === "recording" ? s.recActionStop : s.recActionStart,
                    pressed && s.btnPressed,
                  ]}
                >
                  <Ionicons
                    name={screenState === "recording" ? "stop-circle" : "radio-button-on"}
                    size={20}
                    color="#fff"
                    style={{ marginRight: 8 }}
                  />
                  <Text style={s.recActionText}>
                    {screenState === "recording" ? "Dừng & Phân tích ngay" : "Bắt đầu ghi âm"}
                  </Text>
                </Pressable>

                {/* Divider */}
                <View style={s.dividerRow}>
                  <View style={s.dividerLine} />
                  <Text style={s.dividerText}>HOẶC</Text>
                  <View style={s.dividerLine} />
                </View>

                {/* Upload File Button */}
                <Pressable
                  onPress={handlePickFile}
                  disabled={screenState === "recording" || screenState === "processing"}
                  style={({ pressed }) => [
                    s.uploadBtn,
                    (screenState === "recording" || screenState === "processing") && { opacity: 0.5 },
                    pressed && s.btnPressed,
                  ]}
                >
                  <View style={s.uploadIconCircle}>
                    <Ionicons name="cloud-upload" size={18} color="#818cf8" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.uploadTitle}>Tải file âm thanh có sẵn</Text>
                    <Text style={s.uploadSub}>.mp3, .wav, .m4a, .webm, .flac – tối đa 200MB (60+ phút)</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color="#64748b" />
                </Pressable>

                {/* Selected file info */}
                {selectedFileName ? (
                  <View style={s.selectedFileBox}>
                    <Ionicons name="document" size={14} color="#818cf8" />
                    <Text style={s.selectedFileName} numberOfLines={1}>{selectedFileName}</Text>
                    <Text style={s.selectedFileSize}>{selectedFileSize}</Text>
                  </View>
                ) : null}

                {/* Feature badges */}
                <View style={s.featureBox}>
                  <View style={s.featurePill}>
                    <Ionicons name="shield-checkmark" size={14} color="#34d399" />
                    <Text style={s.featurePillText}>Bảo mật nội bộ 100%</Text>
                  </View>
                  <View style={s.featurePill}>
                    <Ionicons name="flash" size={14} color="#fbbf24" />
                    <Text style={s.featurePillText}>faster-whisper + Qwen2.5</Text>
                  </View>
                  <View style={s.featurePill}>
                    <Ionicons name="time" size={14} color="#38bdf8" />
                    <Text style={s.featurePillText}>Hỗ trợ file 60+ phút</Text>
                  </View>
                </View>

              </View>
            </View>

            {/* ── CỘT PHẢI: Trạng thái & Kết quả AI ── */}
            <View style={s.rightCol}>

              {/* TRẠNG THÁI: IDLE (CHỜ GHI ÂM) */}
              {screenState === "idle" && (
                <View style={s.idleCard}>
                  <View style={s.idleIconBox}>
                    <Ionicons name="sparkles" size={36} color="#818cf8" />
                  </View>
                  <Text style={s.idleTitle}>Trung tâm Trí tuệ Nhân tạo</Text>
                  <Text style={s.idleSub}>
                    Sau khi kết thúc ghi âm hoặc tải file âm thanh, hệ thống sẽ tự động bóc băng tiếng Việt, tóm tắt biên bản và trích xuất danh sách công việc.
                  </Text>

                  <View style={s.capList}>
                    <View style={s.capItem}>
                      <View style={s.capBullet}>
                        <Ionicons name="mic-outline" size={18} color="#818cf8" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.capHead}>Nhận diện giọng nói chuẩn xác</Text>
                        <Text style={s.capBody}>Mô hình faster-whisper tối ưu hóa cho tiếng Việt với VAD lọc im lặng.</Text>
                      </View>
                    </View>

                    <View style={s.capItem}>
                      <View style={s.capBullet}>
                        <Ionicons name="document-text-outline" size={18} color="#34d399" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.capHead}>Biên bản chuyên nghiệp</Text>
                        <Text style={s.capBody}>Map-Reduce chunking tự động xử lý cuộc họp dài 60+ phút.</Text>
                      </View>
                    </View>

                    <View style={s.capItem}>
                      <View style={s.capBullet}>
                        <Ionicons name="checkbox-outline" size={18} color="#fbbf24" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.capHead}>Trích xuất Action Items</Text>
                        <Text style={s.capBody}>Xác định rõ việc cần làm, người phụ trách và thời hạn.</Text>
                      </View>
                    </View>
                  </View>
                </View>
              )}

              {/* TRẠNG THÁI: RECORDING */}
              {screenState === "recording" && (
                <View style={s.recFeedbackCard}>
                  {/* Animated waveform bars */}
                  <View style={s.waveContainer}>
                    {[...Array(12)].map((_, i) => (
                      <WaveBar key={i} index={i} />
                    ))}
                  </View>
                  <Text style={s.recFeedTitle}>Đang lắng nghe cuộc họp...</Text>
                  <Text style={s.recFeedSub}>
                    Hãy nói rõ ràng gần microphone. Sau khi hoàn tất cuộc họp, nhấn "Dừng & Phân tích ngay".
                  </Text>
                </View>
              )}

              {/* TRẠNG THÁI: PROCESSING với LIVE PROGRESS */}
              {screenState === "processing" && (
                <LiveProcessingView progressData={progressData} />
              )}

              {/* TRẠNG THÁI: ERROR */}
              {screenState === "error" && (
                <View style={s.errorCard}>
                  <View style={s.errorIconBox}>
                    <Ionicons name="alert-circle" size={40} color="#f87171" />
                  </View>
                  <Text style={s.errorTitle}>Xử lý thất bại</Text>
                  <Text style={s.errorMsg}>{errorMessage}</Text>
                  {errorDetail ? (
                    <Text style={s.errorDtl}>{errorDetail}</Text>
                  ) : null}
                  <Pressable
                    onPress={handleReset}
                    style={({ pressed }) => [s.retryBtn, pressed && s.btnPressed]}
                  >
                    <Ionicons name="refresh" size={18} color="#fff" style={{ marginRight: 8 }} />
                    <Text style={s.retryBtnText}>Thử lại</Text>
                  </Pressable>
                </View>
              )}

              {/* TRẠNG THÁI: SUCCESS */}
              {screenState === "success" && result && (
                <ResultDashboard
                  meetingId={meetingId}
                  meetingTitle={meetingTitle}
                  result={result}
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                  fadeAnim={fadeAnim}
                  slideAnim={slideAnim}
                  onRecordNew={handleReset}
                />
              )}

            </View>

          </View>
        </ScrollView>

        {/* Modal cấu hình Google Gemini API Key & Engine */}
        <AIConfigModal
          visible={aiConfigModalVisible}
          onClose={() => setAiConfigModalVisible(false)}
        />

      </View>
    </SafeAreaView>
  );
}

// ===========================================================================
// SUB-COMPONENT: WaveBar (Animated waveform bar)
// ===========================================================================
function WaveBar({ index }: { index: number }): React.JSX.Element {
  const anim = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const delay = index * 80;
    const duration = 400 + Math.random() * 400;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 0.3 + Math.random() * 0.7, duration, delay, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.3, duration: duration * 0.8, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, []);

  return (
    <Animated.View style={{
      width: 4,
      height: 36,
      borderRadius: 2,
      backgroundColor: "#f87171",
      marginHorizontal: 2,
      transform: [{ scaleY: anim }],
    }} />
  );
}

// ===========================================================================
// SUB-COMPONENT: LiveProcessingView (Progress stepper + live transcript)
// ===========================================================================
function LiveProcessingView({ progressData }: { progressData: ProgressData | null }): React.JSX.Element {
  const spinAnim = useRef(new Animated.Value(0)).current;
  const percent = progressData?.progress_percent ?? 0;
  const stepDetail = progressData?.current_step_detail ?? "Đang kết nối với AI engine...";
  const partialTranscript = progressData?.partial_transcript ?? "";
  const status = progressData?.status ?? "uploading";

  useEffect(() => {
    Animated.loop(
      Animated.timing(spinAnim, { toValue: 1, duration: 2400, easing: Easing.linear, useNativeDriver: true })
    ).start();
  }, [spinAnim]);

  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  // Determine which step is active
  const isTranscribing = status === "transcribing" || (percent >= 5 && percent < 60);
  const isSummarizing = status === "summarizing" || (percent >= 60 && percent < 100);
  const isCompleted = status === "completed";

  return (
    <View style={procStyles.container}>
      {/* Spinning ring + percent */}
      <View style={procStyles.ringBox}>
        <View style={procStyles.staticRing} />
        <Animated.View style={[procStyles.spinRing, { transform: [{ rotate: spin }] }]} />
        <View style={procStyles.centerPercent}>
          <Text style={procStyles.percentText}>{percent}%</Text>
        </View>
      </View>

      <Text style={procStyles.title}>Local AI đang xử lý...</Text>
      <Text style={procStyles.detail}>{stepDetail}</Text>

      {/* Smooth progress bar */}
      <View style={procStyles.progressBarBg}>
        <View style={[procStyles.progressBarFill, { width: `${Math.min(percent, 100)}%` }]} />
      </View>

      {/* Step indicators */}
      <View style={procStyles.stepList}>
        <View style={[procStyles.stepItem, isTranscribing && procStyles.stepItemActive]}>
          <View style={[
            procStyles.stepCircle,
            (isTranscribing || isSummarizing || isCompleted) && procStyles.stepCircleActive,
            (isSummarizing || isCompleted) && procStyles.stepCircleDone,
          ]}>
            {isSummarizing || isCompleted ? (
              <Ionicons name="checkmark" size={14} color="#fff" />
            ) : isTranscribing ? (
              <ActivityIndicator size="small" color="#818cf8" />
            ) : (
              <Text style={procStyles.stepNum}>1</Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={procStyles.stepTitle}>Bóc băng âm thanh (STT)</Text>
            <Text style={procStyles.stepSub}>faster-whisper với VAD trên GPU local</Text>
          </View>
        </View>

        <View style={[procStyles.stepItem, isSummarizing && procStyles.stepItemActive]}>
          <View style={[
            procStyles.stepCircle,
            (isSummarizing || isCompleted) && procStyles.stepCircleActive,
            isCompleted && procStyles.stepCircleDone,
          ]}>
            {isCompleted ? (
              <Ionicons name="checkmark" size={14} color="#fff" />
            ) : isSummarizing ? (
              <ActivityIndicator size="small" color="#818cf8" />
            ) : (
              <Text style={procStyles.stepNum}>2</Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={procStyles.stepTitle}>Phân tích & Tạo biên bản</Text>
            <Text style={procStyles.stepSub}>Ollama Qwen2.5 Map-Reduce chunking</Text>
          </View>
        </View>
      </View>

      {/* Live Transcript Preview */}
      {partialTranscript ? (
        <View style={procStyles.liveTranscriptBox}>
          <View style={procStyles.liveTranscriptHeader}>
            <Ionicons name="text" size={14} color="#818cf8" />
            <Text style={procStyles.liveTranscriptTitle}>Bóc băng trực tiếp</Text>
            <View style={procStyles.liveDot} />
          </View>
          <ScrollView style={procStyles.liveTranscriptScroll} nestedScrollEnabled>
            <Text style={procStyles.liveTranscriptText}>{partialTranscript}</Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}


// ===========================================================================
// SUB-COMPONENT: ResultDashboard
// ===========================================================================
interface ResultDashboardProps {
  meetingId: number;
  meetingTitle: string;
  result: AIProcessingResult;
  activeTab: "minutes" | "tasks" | "transcript";
  onTabChange: (tab: "minutes" | "tasks" | "transcript") => void;
  fadeAnim: Animated.Value;
  slideAnim: Animated.Value;
  onRecordNew: () => void;
}

function ResultDashboard({
  meetingId,
  meetingTitle,
  result,
  activeTab,
  onTabChange,
  fadeAnim,
  slideAnim,
  onRecordNew,
}: ResultDashboardProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Chế độ: false = Xem Biểu Mẫu Chuẩn, true = Chỉnh Sửa Trực Tiếp
  const [isEditing, setIsEditing] = useState(false);

  // Typography & Document Studio States
  const [fontFamily, setFontFamily] = useState<FontFamilyType>("Times New Roman");
  const [fontSize, setFontSize] = useState<number>(13);
  const [lineHeight, setLineHeight] = useState<number>(1.3);
  const [textAlign, setTextAlign] = useState<TextAlignType>("justify");
  const [paperTheme, setPaperTheme] = useState<PaperThemeType>("white");

  // AI Text Studio States
  const [aiRewriteLoading, setAiRewriteLoading] = useState(false);
  const [aiPromptInput, setAiPromptInput] = useState("");
  const [aiActiveMode, setAiActiveMode] = useState<AIRewriteMode | null>(null);

  // Transcript Editing & Search States
  const [transcriptContent, setTranscriptContent] = useState(result.raw_transcript || "");
  const [isEditingTranscript, setIsEditingTranscript] = useState(false);
  const [isSavingTranscript, setIsSavingTranscript] = useState(false);
  const [savedTranscriptToast, setSavedTranscriptToast] = useState(false);
  const [transcriptSearch, setTranscriptSearch] = useState("");

  // Template Data State (chỉnh sửa trực tiếp trên màn hình)
  const [docTitle, setDocTitle] = useState(meetingTitle || "Cuộc họp định kỳ");
  const [docDate, setDocDate] = useState(() => {
    const now = new Date();
    return `ngày ${now.getDate()} tháng ${now.getMonth() + 1} năm ${now.getFullYear()}`;
  });
  const [docTime, setDocTime] = useState(() => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const mo = String(now.getMonth() + 1).padStart(2, "0");
    const yyyy = now.getFullYear();
    return `${hh}:${mm}, ngày ${dd}/${mo}/${yyyy}`;
  });
  const [docLocation, setDocLocation] = useState("Phòng họp số 1 / Trực tiếp kết hợp trực tuyến");
  const [docChair, setDocChair] = useState("Đồng chí Chủ trì / Ban Giám đốc");
  const [docSecretary, setDocSecretary] = useState("Bộ phận Thư ký ghi chép AI");
  const [docAttendees, setDocAttendees] = useState("Đại diện các cơ quan, đơn vị và đại biểu tham dự");
  const [minutesContent, setMinutesContent] = useState(result.minutes || "");

  // Tasks State
  const [tasks, setTasks] = useState(
    result.tasks.map((t, idx) => ({
      ...t,
      isDone: (t as any).status === "done" || false,
      realId: (t as any).id ?? idx,
    }))
  );

  // Sync tasks when result changes
  useEffect(() => {
    if (result.tasks && result.tasks.length > 0) {
      setTasks(
        result.tasks.map((t, idx) => ({
          ...t,
          isDone: (t as any).status === "done" || false,
          realId: (t as any).id ?? idx,
        }))
      );
    }
  }, [result.tasks]);

  // Sync minutes text when result changes
  useEffect(() => {
    if (result.minutes) {
      setMinutesContent(result.minutes);
    }
  }, [result.minutes]);

  // Sync transcript text when result changes
  useEffect(() => {
    if (result.raw_transcript) {
      setTranscriptContent(result.raw_transcript);
    }
  }, [result.raw_transcript]);

  // Paper Theme Colors Mapping
  const themeColors = useMemo(() => {
    if (paperTheme === "sepia") {
      return {
        bg: "#FBF7EE",
        text: "#1F2937",
        textMuted: "#4B5563",
        border: "#E7E0D3",
        headBorder: "#D6CEBE",
        tableHeaderBg: "#F2EBDC",
        tableRowEven: "#F8F4EA",
        tableBorder: "#D6CEBE",
        inputBg: "#F5EFE0",
        editorBg: "#F7F2E6",
        chipActiveBg: "#4F46E5",
        chipActiveText: "#FFFFFF",
      };
    }
    if (paperTheme === "dark") {
      return {
        bg: "#0F172A",
        text: "#F8FAFC",
        textMuted: "#94A3B8",
        border: "#334155",
        headBorder: "#334155",
        tableHeaderBg: "#1E293B",
        tableRowEven: "#162032",
        tableBorder: "#334155",
        inputBg: "#1E293B",
        editorBg: "#111827",
        chipActiveBg: "#6366F1",
        chipActiveText: "#FFFFFF",
      };
    }
    return {
      bg: "#FFFFFF",
      text: "#0F172A",
      textMuted: "#334155",
      border: "#CBD5E1",
      headBorder: "#CBD5E1",
      tableHeaderBg: "#F1F5F9",
      tableRowEven: "#F8FAFC",
      tableBorder: "#CBD5E1",
      inputBg: "#F8FAFC",
      editorBg: "#F8FAFC",
      chipActiveBg: "#4F46E5",
      chipActiveText: "#FFFFFF",
    };
  }, [paperTheme]);

  // Toggle task checkbox
  const handleToggleTask = async (index: number, taskId: number) => {
    const current = tasks[index];
    const newDone = !current.isDone;
    setTasks((prev) => prev.map((t, i) => (i === index ? { ...t, isDone: newDone } : t)));

    if (typeof taskId === "number" && taskId > 0) {
      try {
        await axios.patch(
          `${BASE_URL}/api/v1/tasks/${taskId}`,
          { status: newDone ? "done" : "pending" },
          { headers: { "Content-Type": "application/json" }, timeout: API_TIMEOUT_SHORT_MS }
        );
      } catch {
        setTasks((prev) => prev.map((t, i) => (i === index ? { ...t, isDone: current.isDone } : t)));
      }
    }
  };

  // Sao chép text
  const handleCopyText = async (textToCopy: string) => {
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(textToCopy);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch { /* ignore */ }
    } else {
      Clipboard.setString(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Lưu biên bản vào database (PUT /api/v1/meetings/{id})
  const handleSaveToDB = async () => {
    setIsSaving(true);
    try {
      await axios.put(
        `${BASE_URL}/api/v1/meetings/${meetingId}`,
        {
          title: docTitle,
          final_minutes: minutesContent,
        },
        { headers: { "Content-Type": "application/json" }, timeout: API_TIMEOUT_MS }
      );
      setSavedToast(true);
      setTimeout(() => setSavedToast(false), 2500);
    } catch {
      Alert.alert("Lỗi", "Không thể lưu biên bản lên server. Vui lòng kiểm tra lại kết nối.");
    } finally {
      setIsSaving(false);
    }
  };

  // Lưu bản gỡ băng vào database (PUT /api/v1/meetings/{id})
  const handleSaveTranscriptToDB = async () => {
    setIsSavingTranscript(true);
    try {
      await axios.put(
        `${BASE_URL}/api/v1/meetings/${meetingId}`,
        { raw_transcript: transcriptContent },
        { headers: { "Content-Type": "application/json" }, timeout: API_TIMEOUT_MS }
      );
      setSavedTranscriptToast(true);
      setTimeout(() => setSavedTranscriptToast(false), 2500);
      setIsEditingTranscript(false);
    } catch {
      Alert.alert("Lỗi", "Không thể lưu bản gỡ băng lên server.");
    } finally {
      setIsSavingTranscript(false);
    }
  };

  // Chèn ký tự định dạng nhanh vào editor
  const insertFormatting = (prefix: string, suffix: string = "") => {
    setMinutesContent((prev) => {
      const needsNewline = prev.length > 0 && !prev.endsWith("\n");
      return prev + (needsNewline ? "\n" : "") + prefix + suffix;
    });
  };

  // Khôi phục bản gốc ban đầu của AI
  const handleResetMinutes = () => {
    if (Platform.OS === "web") {
      if (window.confirm("Bạn có chắc chắn muốn khôi phục lại nội dung biên bản ban đầu từ AI? Mọi chỉnh sửa thủ công sẽ được hoàn tác.")) {
        setMinutesContent(result.minutes || "");
      }
    } else {
      Alert.alert(
        "Khôi phục bản gốc",
        "Bạn có chắc muốn hoàn tác mọi chỉnh sửa về văn bản AI ban đầu?",
        [
          { text: "Hủy", style: "cancel" },
          { text: "Khôi phục", style: "destructive", onPress: () => setMinutesContent(result.minutes || "") },
        ]
      );
    }
  };

  // Gọi Gemini AI Rewrite Endpoint
  const handleAIRewrite = async (mode: AIRewriteMode, customPrompt?: string) => {
    if (aiRewriteLoading) return;
    setAiRewriteLoading(true);
    setAiActiveMode(mode);
    try {
      const res = await axios.post<MeetingRead>(
        API_ENDPOINTS.aiRewrite(meetingId),
        {
          mode,
          custom_instruction: customPrompt || (mode === "custom" ? aiPromptInput.trim() : undefined),
        },
        { timeout: 90000 }
      );
      const updated = res.data;
      if (updated.final_minutes) {
        setMinutesContent(updated.final_minutes);
      }
      if (updated.title) {
        setDocTitle(updated.title);
      }
      if (updated.tasks && updated.tasks.length > 0) {
        setTasks(
          updated.tasks.map((t, idx) => ({
            title: t.title,
            description: t.description ?? null,
            assignee_name: null,
            due_date: null,
            id: t.id,
            status: t.status,
            isDone: t.status === "done",
            realId: t.id ?? idx,
          }))
        );
      }
      if (mode === "custom") {
        setAiPromptInput("");
      }
      Alert.alert("✨ Thành công", "Biên bản và nhiệm vụ đã được AI Gemini tái cấu trúc hoàn tất!");
    } catch (err: any) {
      const msg = err.response?.data?.detail || "Không thể thực hiện tái cấu trúc AI. Vui lòng kiểm tra API Key.";
      Alert.alert("Lỗi AI Studio", typeof msg === "string" ? msg : JSON.stringify(msg));
    } finally {
      setAiRewriteLoading(false);
      setAiActiveMode(null);
    }
  };

  // =========================================================================
  // XUẤT VÀ TẢI FILE WORD (.DOC) ĐỒNG BỘ 100% PHÔNG CHỮ & ĐỊNH DẠNG
  // =========================================================================
  const generateWordHtml = () => {
    const cleanMd = (text: string) =>
      text
        .replace(/^#+\s*/gm, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/__(.*?)__/g, "$1")
        .replace(/_(.*?)_/g, "$1")
        .trim();

    const fontCss =
      fontFamily === "Times New Roman"
        ? "'Times New Roman', Times, serif"
        : fontFamily === "Arial"
        ? "Arial, Helvetica, sans-serif"
        : fontFamily === "Roboto"
        ? "'Roboto', 'Segoe UI', sans-serif"
        : fontFamily === "Georgia"
        ? "Georgia, 'Palatino Linotype', serif"
        : "Tahoma, 'Segoe UI', sans-serif";

    const baseFontSizePt = `${fontSize}pt`;
    const headingFontSizePt = `${Math.round(fontSize * 1.08)}pt`;
    const titleMainFontSizePt = `${Math.round(fontSize * 1.3)}pt`;
    const tableFontSizePt = `${Math.max(10, fontSize - 1)}pt`;

    const minutesParagraphs = minutesContent
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const cleaned = cleanMd(line);
        if (line.startsWith("#") || line.match(/^[1-9IVX]+\.\s+/)) {
          const heading = cleanMd(line.replace(/^#+\s*/, ""));
          return `<p style="font-size: ${headingFontSizePt}; font-weight: bold; margin-top: 14px; margin-bottom: 4px; text-align: ${textAlign};">${heading}</p>`;
        }
        if (line.startsWith("-") || line.startsWith("*") || line.startsWith("•")) {
          const bullet = cleanMd(line.replace(/^[-*•]\s*/, ""));
          return `<p style="margin: 4px 0 4px 1.25cm; text-align: ${textAlign}; font-size: ${baseFontSizePt}; line-height: ${lineHeight};">• ${bullet}</p>`;
        }
        return `<p style="text-indent: 1.25cm; margin: 5px 0; text-align: ${textAlign}; font-size: ${baseFontSizePt}; line-height: ${lineHeight};">${cleaned}</p>`;
      })
      .join("\n");

    const taskRows = tasks.length > 0
      ? tasks.map((t, idx) => `
        <tr>
          <td align="center" style="border: 1px solid #000; padding: 6px 8px; font-size: ${tableFontSizePt};">${idx + 1}</td>
          <td style="border: 1px solid #000; padding: 6px 8px; font-size: ${tableFontSizePt};">
            <b>${t.title}</b>
            ${t.description ? `<br/><span style="font-size: 10pt; color: #444; font-style: italic;">${t.description}</span>` : ""}
          </td>
          <td align="center" style="border: 1px solid #000; padding: 6px 8px; font-size: ${tableFontSizePt};">${t.assignee_name || "Các đơn vị liên quan"}</td>
          <td align="center" style="border: 1px solid #000; padding: 6px 8px; font-size: ${tableFontSizePt};">${t.due_date || "Kế hoạch sắp tới"}</td>
        </tr>
      `).join("\n")
      : `
        <tr>
          <td colspan="4" align="center" style="border: 1px solid #000; padding: 12px; font-style: italic; color: #666; font-size: ${tableFontSizePt};">
            Không có nhiệm vụ hành động cụ thể nào phát sinh trong cuộc họp.
          </td>
        </tr>
      `;

    return `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head>
  <meta charset='utf-8'>
  <title>Biên bản cuộc họp - ${docTitle}</title>
  <!--[if gte mso 9]>
  <xml>
    <w:WordDocument>
      <w:View>Print</w:View>
      <w:Zoom>100</w:Zoom>
      <w:DoNotOptimizeForBrowser/>
    </w:WordDocument>
  </xml>
  <![endif]-->
  <style>
    @page {
      size: 210mm 297mm;
      margin: 20mm 20mm 20mm 25mm;
      mso-page-orientation: portrait;
    }
    body {
      font-family: ${fontCss};
      font-size: ${baseFontSizePt};
      line-height: ${lineHeight};
      color: #000000;
    }
    p {
      margin: 4px 0;
      line-height: ${lineHeight};
      text-align: ${textAlign};
    }
    table.header-table {
      width: 100%;
      border-collapse: collapse;
      border: none;
      margin-bottom: 12px;
    }
    table.header-table td {
      border: none;
      vertical-align: top;
      text-align: center;
      padding: 0 4px;
    }
    .org-name {
      font-size: ${tableFontSizePt};
      font-weight: bold;
      text-transform: uppercase;
    }
    .doc-no {
      font-size: ${tableFontSizePt};
      margin-top: 4px;
    }
    .nation-name {
      font-size: ${baseFontSizePt};
      font-weight: bold;
      text-transform: uppercase;
    }
    .motto {
      font-size: ${baseFontSizePt};
      font-weight: bold;
    }
    .motto-line {
      font-size: 11pt;
      letter-spacing: -1px;
    }
    .date-line {
      text-align: right;
      font-style: italic;
      font-size: ${baseFontSizePt};
      margin-bottom: 22px;
    }
    .title-main {
      text-align: center;
      font-size: ${titleMainFontSizePt};
      font-weight: bold;
      text-transform: uppercase;
      margin-top: 10px;
      margin-bottom: 4px;
    }
    .title-sub {
      text-align: center;
      font-size: ${baseFontSizePt};
      font-weight: bold;
      font-style: italic;
      margin-bottom: 24px;
    }
    .section-head {
      font-size: ${headingFontSizePt};
      font-weight: bold;
      text-transform: uppercase;
      margin-top: 18px;
      margin-bottom: 8px;
    }
    table.data-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      margin-bottom: 18px;
    }
    table.data-table th {
      border: 1px solid #000000;
      background-color: #f2f2f2;
      font-weight: bold;
      text-align: center;
      padding: 6px 8px;
      font-size: ${tableFontSizePt};
    }
    table.sig-table {
      width: 100%;
      border-collapse: collapse;
      border: none;
      margin-top: 35px;
      page-break-inside: avoid;
    }
    table.sig-table td {
      border: none;
      text-align: center;
      vertical-align: top;
      width: 50%;
    }
    .sig-role {
      font-size: ${baseFontSizePt};
      font-weight: bold;
      text-transform: uppercase;
    }
    .sig-note {
      font-size: 11pt;
      font-style: italic;
      margin-top: 2px;
    }
    .sig-space {
      height: 75px;
    }
  </style>
</head>
<body>

  <!-- Quốc hiệu & Tiêu ngữ -->
  <table class="header-table">
    <tr>
      <td style="width: 45%;">
        <div class="org-name">VIETMEETING AI WORKSPACE</div>
        <div class="doc-no">Số: ${String(meetingId).padStart(4, "0")}/BB-CH</div>
      </td>
      <td style="width: 55%;">
        <div class="nation-name">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
        <div class="motto">Độc lập - Tự do - Hạnh phúc</div>
        <div class="motto-line">-------------------</div>
      </td>
    </tr>
  </table>

  <div class="date-line">Hà Nội, ${docDate}</div>

  <div class="title-main">BIÊN BẢN CUỘC HỌP</div>
  <div class="title-sub">${docTitle}</div>

  <!-- Mục I. THÔNG TIN CHUNG -->
  <div class="section-head">I. THÔNG TIN CHUNG</div>
  <p style="text-indent: 1.25cm; margin: 4px 0;"><b>1. Thời gian:</b> ${docTime}.</p>
  <p style="text-indent: 1.25cm; margin: 4px 0;"><b>2. Địa điểm / Hình thức:</b> ${docLocation}.</p>
  <p style="text-indent: 1.25cm; margin: 4px 0;"><b>3. Chủ trì cuộc họp:</b> ${docChair}.</p>
  <p style="text-indent: 1.25cm; margin: 4px 0;"><b>4. Thư ký ghi biên bản:</b> ${docSecretary}.</p>
  <p style="text-indent: 1.25cm; margin: 4px 0;"><b>5. Thành phần tham dự:</b> ${docAttendees}.</p>

  <!-- Mục II. NỘI DUNG DIỄN BIẾN CUỘC HỌP -->
  <div class="section-head">II. NỘI DUNG DIỄN BIẾN CUỘC HỌP</div>
  ${minutesParagraphs}

  <!-- Mục III. BẢNG PHÂN CÔNG NHIỆM VỤ / KẾT LUẬN CHỈ ĐẠO -->
  <div class="section-head">III. BẢNG PHÂN CÔNG NHIỆM VỤ / KẾT LUẬN CHỈ ĐẠO</div>
  <table class="data-table">
    <thead>
      <tr>
        <th style="width: 8%;">STT</th>
        <th style="width: 52%;">Nội dung công việc / Chỉ đạo</th>
        <th style="width: 25%;">Đơn vị / Người phụ trách</th>
        <th style="width: 15%;">Thời hạn</th>
      </tr>
    </thead>
    <tbody>
      ${taskRows}
    </tbody>
  </table>

  <!-- Phần Chữ ký cuối trang -->
  <table class="sig-table">
    <tr>
      <td>
        <div class="sig-role">THƯ KÝ GHI BIÊN BẢN</div>
        <div class="sig-note">(Ký và ghi rõ họ tên)</div>
        <div class="sig-space"></div>
        <div><i>(Đã ký điện tử)</i></div>
      </td>
      <td>
        <div class="sig-role">CHỦ TRÌ CUỘC HỌP</div>
        <div class="sig-note">(Ký và ghi rõ họ tên)</div>
        <div class="sig-space"></div>
        <div><i>(Đã duyệt & ký)</i></div>
      </td>
    </tr>
  </table>

</body>
</html>`;
  };

  const handleDownloadWord = () => {
    const htmlContent = generateWordHtml();
    const safeTitle = docTitle.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_").slice(0, 30) || String(meetingId);
    const fileName = `Bien_Ban_Cuoc_Hop_${safeTitle}.doc`;
    const exportDocUrl = `${BASE_URL}/api/v1/meetings/${meetingId}/export-doc?font_family=${encodeURIComponent(fontFamily)}&font_size=${fontSize}&line_height=${lineHeight}&text_align=${textAlign}`;

    if (Platform.OS === "web") {
      try {
        const blob = new Blob(["\ufeff" + htmlContent], {
          type: "application/msword;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } catch {
        window.open(exportDocUrl, "_blank");
      }
    } else {
      Linking.openURL(exportDocUrl);
    }
  };

  const handlePrint = () => {
    if (Platform.OS === "web") {
      window.print();
    } else {
      const exportDocUrl = `${BASE_URL}/api/v1/meetings/${meetingId}/export-doc?font_family=${encodeURIComponent(fontFamily)}&font_size=${fontSize}&line_height=${lineHeight}&text_align=${textAlign}`;
      Linking.openURL(exportDocUrl);
    }
  };

  const completedTasksCount = tasks.filter((t) => t.isDone).length;

  // Tính số lượng từ khóa tìm thấy trong transcript
  const transcriptMatchCount = useMemo(() => {
    if (!transcriptSearch.trim() || !transcriptContent) return 0;
    try {
      const escaped = transcriptSearch.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "gi");
      const matches = transcriptContent.match(regex);
      return matches ? matches.length : 0;
    } catch {
      return 0;
    }
  }, [transcriptSearch, transcriptContent]);

  // Component Toolbar Kiểu Chữ & Trình Bày (Dùng chung)
  const renderTypographyToolbar = () => (
    <View style={resStyles.typoCard}>
      {/* Hàng 1: Chọn Phông Chữ & Giao Diện Giấy */}
      <View style={resStyles.typoRow}>
        <View style={resStyles.typoGroup}>
          <Text style={resStyles.typoLabel}>Phông chữ:</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {(
              [
                { id: "Times New Roman" as const, name: "Times New Roman", note: "Nghị định 30" },
                { id: "Arial" as const, name: "Arial", note: "Rõ nét" },
                { id: "Roboto" as const, name: "Roboto", note: "Công nghệ" },
                { id: "Georgia" as const, name: "Georgia", note: "Học thuật" },
                { id: "Tahoma" as const, name: "Tahoma", note: "Dễ đọc" },
              ] as const
            ).map((font) => {
              const isSelected = fontFamily === font.id;
              return (
                <Pressable
                  key={font.id}
                  onPress={() => setFontFamily(font.id)}
                  style={[resStyles.fontPill, isSelected && resStyles.fontPillActive]}
                >
                  <Text style={[resStyles.fontPillText, isSelected && resStyles.fontPillTextActive]}>
                    {font.name}
                  </Text>
                  <Text style={[resStyles.fontPillNote, isSelected && { color: "#E0E7FF" }]}>
                    {font.note}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        <View style={resStyles.typoGroup}>
          <Text style={resStyles.typoLabel}>Nền trang:</Text>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {(
              [
                { id: "white" as const, label: "📄 Trắng A4" },
                { id: "sepia" as const, label: "📜 Giấy Ngà" },
                { id: "dark" as const, label: "🌙 Tối Studio" },
              ] as const
            ).map((theme) => {
              const isSelected = paperTheme === theme.id;
              return (
                <Pressable
                  key={theme.id}
                  onPress={() => setPaperTheme(theme.id)}
                  style={[
                    resStyles.themePill,
                    isSelected && resStyles.themePillActive,
                  ]}
                >
                  <Text style={[resStyles.themePillText, isSelected && resStyles.themePillTextActive]}>
                    {theme.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>

      {/* Hàng 2: Cỡ Chữ, Giãn Dòng & Căn Lề */}
      <View style={[resStyles.typoRow, { borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)", paddingTop: 10 }]}>
        {/* Cỡ chữ */}
        <View style={resStyles.typoGroup}>
          <Text style={resStyles.typoLabel}>Cỡ chữ:</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Pressable
              onPress={() => setFontSize((prev) => Math.max(11, prev - 1))}
              style={({ pressed }) => [resStyles.sizeStepperBtn, pressed && resStyles.btnPressed]}
            >
              <Text style={resStyles.sizeStepperText}>A-</Text>
            </Pressable>
            {[11, 12, 13, 14, 15, 16].map((s) => {
              const isSelected = fontSize === s;
              return (
                <Pressable
                  key={s}
                  onPress={() => setFontSize(s)}
                  style={[resStyles.sizePill, isSelected && resStyles.sizePillActive]}
                >
                  <Text style={[resStyles.sizePillText, isSelected && resStyles.sizePillTextActive]}>
                    {s}{s === 13 ? "★" : ""}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => setFontSize((prev) => Math.min(16, prev + 1))}
              style={({ pressed }) => [resStyles.sizeStepperBtn, pressed && resStyles.btnPressed]}
            >
              <Text style={resStyles.sizeStepperText}>A+</Text>
            </Pressable>
          </View>
        </View>

        {/* Giãn dòng */}
        <View style={resStyles.typoGroup}>
          <Text style={resStyles.typoLabel}>Giãn dòng:</Text>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {[
              { val: 1.15, label: "1.15" },
              { val: 1.3, label: "1.30 (Chuẩn)" },
              { val: 1.5, label: "1.50" },
              { val: 1.8, label: "1.80" },
            ].map((lh) => {
              const isSelected = lineHeight === lh.val;
              return (
                <Pressable
                  key={lh.val}
                  onPress={() => setLineHeight(lh.val)}
                  style={[resStyles.spacingPill, isSelected && resStyles.spacingPillActive]}
                >
                  <Text style={[resStyles.spacingPillText, isSelected && resStyles.spacingPillTextActive]}>
                    {lh.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Căn lề */}
        <View style={resStyles.typoGroup}>
          <Text style={resStyles.typoLabel}>Căn lề:</Text>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {[
              { id: "justify" as const, icon: "reorder-four-outline" as const, label: "Đều" },
              { id: "left" as const, icon: "reorder-three-outline" as const, label: "Trái" },
              { id: "center" as const, icon: "reorder-two-outline" as const, label: "Giữa" },
            ].map((align) => {
              const isSelected = textAlign === align.id;
              return (
                <Pressable
                  key={align.id}
                  onPress={() => setTextAlign(align.id)}
                  style={[resStyles.alignBtn, isSelected && resStyles.alignBtnActive]}
                >
                  <Ionicons
                    name={align.icon}
                    size={16}
                    color={isSelected ? "#818cf8" : "#94a3b8"}
                  />
                  <Text style={[resStyles.alignBtnText, isSelected && { color: "#a5b4fc" }]}>
                    {align.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </View>
  );

  // Component AI Text Studio ("✨ Trợ Lý Biên Tập Văn Bản AI")
  const renderAITextStudio = () => (
    <View style={resStyles.aiStudioCard}>
      <View style={resStyles.aiStudioHeader}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={resStyles.aiSparkleIcon}>
            <Ionicons name="sparkles" size={16} color="#818cf8" />
          </View>
          <View>
            <Text style={resStyles.aiStudioTitle}>✨ Trợ Lý Biên Tập Văn Bản AI (Powered by Gemini)</Text>
            <Text style={resStyles.aiStudioSub}>
              Tái cấu trúc biên bản theo văn phong chuyên biệt hoặc ra lệnh tùy ý trong vài giây
            </Text>
          </View>
        </View>
        {aiRewriteLoading ? (
          <View style={resStyles.aiLoadingBadge}>
            <ActivityIndicator size="small" color="#818cf8" />
            <Text style={resStyles.aiLoadingText}>Gemini đang biên tập...</Text>
          </View>
        ) : null}
      </View>

      {/* Dải nút Preset */}
      <View style={resStyles.aiPresetsRow}>
        {(
          [
            { mode: "administrative" as const, label: "🏛️ Hành chính Chuẩn", desc: "Nghị định 30" },
            { mode: "corporate" as const, label: "💼 Doanh nghiệp / Dự án", desc: "KPI & Quyết định" },
            { mode: "news_digest" as const, label: "📰 Bản tin / Sự kiện", desc: "Chia theo mục tin" },
            { mode: "concise" as const, label: "⚡ Tóm tắt Ngắn gọn", desc: "Executive 1-Trang" },
            { mode: "detailed" as const, label: "🔍 Phân tích Chi tiết", desc: "Mở rộng số liệu" },
          ] as const
        ).map((preset) => {
          const isActive = aiActiveMode === preset.mode;
          return (
            <Pressable
              key={preset.mode}
              disabled={aiRewriteLoading}
              onPress={() => handleAIRewrite(preset.mode)}
              style={({ pressed }) => [
                resStyles.aiPresetBtn,
                isActive && resStyles.aiPresetBtnActive,
                pressed && resStyles.btnPressed,
              ]}
            >
              <Text style={resStyles.aiPresetLabel}>{preset.label}</Text>
              <Text style={resStyles.aiPresetDesc}>{preset.desc}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Thanh Ra Lệnh Tùy Biến (Custom Prompt) */}
      <View style={resStyles.aiPromptBar}>
        <TextInput
          value={aiPromptInput}
          onChangeText={setAiPromptInput}
          placeholder="✨ Nhập yêu cầu tùy chỉnh cho Gemini... (VD: Trích xuất các số liệu thống kê, viết lại kết luận trang trọng...)"
          placeholderTextColor="#64748b"
          style={resStyles.aiPromptInput}
          editable={!aiRewriteLoading}
        />
        <Pressable
          onPress={() => handleAIRewrite("custom")}
          disabled={aiRewriteLoading || !aiPromptInput.trim()}
          style={({ pressed }) => [
            resStyles.aiPromptSubmitBtn,
            (!aiPromptInput.trim() || aiRewriteLoading) && { opacity: 0.5 },
            pressed && resStyles.btnPressed,
          ]}
        >
          <Ionicons name="send" size={14} color="#ffffff" style={{ marginRight: 6 }} />
          <Text style={resStyles.aiPromptSubmitText}>Thực hiện</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <Animated.View style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>

      {/* Result Top Summary Banner */}
      <View style={resStyles.topBanner}>
        <View style={resStyles.topBannerLeft}>
          <View style={resStyles.successCircle}>
            <Ionicons name="checkmark" size={24} color="#34d399" />
          </View>
          <View>
            <Text style={resStyles.topBannerTitle}>Biên bản & Nhiệm vụ đã hoàn tất</Text>
            <Text style={resStyles.topBannerSub}>
              Hệ thống đã trích xuất {tasks.length} nhiệm vụ hành động chuẩn xác
            </Text>
          </View>
        </View>

        <Pressable
          onPress={onRecordNew}
          style={({ pressed }) => [resStyles.newRecBtn, pressed && resStyles.btnPressed]}
        >
          <Ionicons name="refresh" size={16} color="#818cf8" style={{ marginRight: 6 }} />
          <Text style={resStyles.newRecBtnText}>Ghi âm phiên mới</Text>
        </Pressable>
      </View>

      {/* Tabs Switcher */}
      <View style={resStyles.tabsRow}>
        {[
          { id: "minutes" as const, label: "Biên bản cuộc họp (Mẫu chuẩn)", icon: "document-text-outline" as const },
          { id: "tasks" as const, label: `Công việc (${completedTasksCount}/${tasks.length})`, icon: "checkbox-outline" as const },
          { id: "transcript" as const, label: "Bản gỡ băng", icon: "mic-outline" as const },
        ].map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <Pressable
              key={tab.id}
              onPress={() => onTabChange(tab.id)}
              style={[resStyles.tabBtn, isActive && resStyles.tabBtnActive]}
            >
              <Ionicons
                name={tab.icon}
                size={16}
                color={isActive ? "#818cf8" : "#94a3b8"}
                style={{ marginRight: 6 }}
              />
              <Text style={[resStyles.tabText, isActive && resStyles.tabTextActive]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* =====================================================================
          TAB 1: BIÊN BẢN CUỘC HỌP (KHUNG BIỂU MẪU CHUẨN NGHỊ ĐỊNH 30)
      ===================================================================== */}
      {activeTab === "minutes" && (
        <View style={{ gap: 14 }}>

          {/* AI Text Studio Banner */}
          {renderAITextStudio()}

          {/* Typography & Document Toolbar */}
          {renderTypographyToolbar()}

          {/* Action Toolbar */}
          <View style={resStyles.toolbarCard}>
            <View style={resStyles.toolbarLeft}>
              {/* Primary Download Word Button */}
              <Pressable
                onPress={handleDownloadWord}
                style={({ pressed }) => [resStyles.wordDownloadBtn, pressed && resStyles.btnPressed]}
              >
                <Ionicons name="download" size={18} color="#ffffff" style={{ marginRight: 8 }} />
                <Text style={resStyles.wordDownloadBtnText}>Tải Biên Bản Word (.DOC)</Text>
              </Pressable>

              {/* Print / PDF Button */}
              <Pressable
                onPress={handlePrint}
                style={({ pressed }) => [resStyles.toolBtn, pressed && resStyles.btnPressed]}
              >
                <Ionicons name="print-outline" size={16} color="#cbd5e1" style={{ marginRight: 6 }} />
                <Text style={resStyles.toolBtnText}>In / Xuất PDF</Text>
              </Pressable>
            </View>

            <View style={resStyles.toolbarRight}>
              {/* Edit / Preview Toggle */}
              <Pressable
                onPress={() => setIsEditing(!isEditing)}
                style={({ pressed }) => [
                  resStyles.toolBtn,
                  isEditing && resStyles.toolBtnActive,
                  pressed && resStyles.btnPressed,
                ]}
              >
                <Ionicons
                  name={isEditing ? "eye-outline" : "create-outline"}
                  size={16}
                  color={isEditing ? "#818cf8" : "#cbd5e1"}
                  style={{ marginRight: 6 }}
                />
                <Text style={[resStyles.toolBtnText, isEditing && { color: "#a5b4fc" }]}>
                  {isEditing ? "👁️ Xem mẫu chuẩn" : "✏️ Chỉnh sửa biểu mẫu"}
                </Text>
              </Pressable>

              {/* Save Button */}
              <Pressable
                onPress={handleSaveToDB}
                disabled={isSaving}
                style={({ pressed }) => [resStyles.toolBtn, pressed && resStyles.btnPressed]}
              >
                {isSaving ? (
                  <ActivityIndicator size="small" color="#34d399" />
                ) : (
                  <Ionicons name={savedToast ? "checkmark-circle" : "save-outline"} size={16} color="#34d399" style={{ marginRight: 6 }} />
                )}
                <Text style={[resStyles.toolBtnText, { color: "#34d399" }]}>
                  {savedToast ? "Đã lưu!" : "Lưu thay đổi"}
                </Text>
              </Pressable>

              {/* Copy Text */}
              <Pressable
                onPress={() => handleCopyText(minutesContent)}
                style={({ pressed }) => [resStyles.toolBtn, pressed && resStyles.btnPressed]}
              >
                <Ionicons name={copied ? "checkmark-circle" : "copy-outline"} size={16} color="#818cf8" style={{ marginRight: 6 }} />
                <Text style={resStyles.toolBtnText}>{copied ? "Đã sao chép!" : "Sao chép"}</Text>
              </Pressable>
            </View>
          </View>

          {/* Quick Formatting Bar khi ở Chế độ Chỉnh sửa */}
          {isEditing && (
            <View style={resStyles.quickFormatCard}>
              <View style={resStyles.quickFormatLeft}>
                <Text style={resStyles.quickFormatLabel}>Định dạng nhanh:</Text>
                <Pressable
                  onPress={() => insertFormatting("**", "**")}
                  style={({ pressed }) => [resStyles.qfBtn, pressed && resStyles.btnPressed]}
                >
                  <Text style={[resStyles.qfBtnText, { fontWeight: "900" }]}>B</Text>
                </Pressable>
                <Pressable
                  onPress={() => insertFormatting("*", "*")}
                  style={({ pressed }) => [resStyles.qfBtn, pressed && resStyles.btnPressed]}
                >
                  <Text style={[resStyles.qfBtnText, { fontStyle: "italic" }]}>I</Text>
                </Pressable>
                <Pressable
                  onPress={() => insertFormatting("<u>", "</u>")}
                  style={({ pressed }) => [resStyles.qfBtn, pressed && resStyles.btnPressed]}
                >
                  <Text style={[resStyles.qfBtnText, { textDecorationLine: "underline" }]}>U</Text>
                </Pressable>
                <Pressable
                  onPress={() => insertFormatting("• ")}
                  style={({ pressed }) => [resStyles.qfBtn, pressed && resStyles.btnPressed]}
                >
                  <Text style={resStyles.qfBtnText}>• Bullet</Text>
                </Pressable>
                <Pressable
                  onPress={() => insertFormatting("### I. ")}
                  style={({ pressed }) => [resStyles.qfBtn, pressed && resStyles.btnPressed]}
                >
                  <Text style={resStyles.qfBtnText}>I. Mục lớn</Text>
                </Pressable>
                <Pressable
                  onPress={() => insertFormatting("\n---\n")}
                  style={({ pressed }) => [resStyles.qfBtn, pressed && resStyles.btnPressed]}
                >
                  <Text style={resStyles.qfBtnText}>--- Kẻ ngang</Text>
                </Pressable>
              </View>

              <Pressable
                onPress={handleResetMinutes}
                style={({ pressed }) => [resStyles.undoResetBtn, pressed && resStyles.btnPressed]}
              >
                <Ionicons name="refresh-circle-outline" size={16} color="#f87171" style={{ marginRight: 4 }} />
                <Text style={resStyles.undoResetText}>Khôi phục bản gốc AI</Text>
              </Pressable>
            </View>
          )}

          {/* DOCUMENT PREVIEW PAPER SHEET (TRANG GIẤY CHUẨN THỂ THỨC HÀNH CHÍNH NGHỊ ĐỊNH 30) */}
          <View
            style={[
              resStyles.paperSheet,
              {
                backgroundColor: themeColors.bg,
                borderColor: themeColors.border,
              },
            ]}
          >
            {/* Header: 2 Columns */}
            <View style={[resStyles.paperHeaderRow, { borderBottomColor: themeColors.border }]}>
              <View style={resStyles.paperHeaderLeft}>
                <Text style={[resStyles.paperOrgName, { color: themeColors.text, fontFamily }]}>
                  VIETMEETING AI WORKSPACE
                </Text>
                <Text style={[resStyles.paperDocNo, { color: themeColors.textMuted, fontFamily }]}>
                  Số: {String(meetingId).padStart(4, "0")}/BB-CH
                </Text>
              </View>
              <View style={resStyles.paperHeaderRight}>
                <Text style={[resStyles.paperNationName, { color: themeColors.text, fontFamily }]}>
                  CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM
                </Text>
                <Text style={[resStyles.paperMotto, { color: themeColors.text, fontFamily }]}>
                  Độc lập - Tự do - Hạnh phúc
                </Text>
                <Text style={[resStyles.paperMottoLine, { color: themeColors.textMuted }]}>
                  -------------------
                </Text>
              </View>
            </View>

            {/* Date line */}
            <View style={resStyles.paperDateRow}>
              {isEditing ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={[resStyles.paperDateLabel, { color: themeColors.textMuted, fontFamily }]}>Hà Nội,</Text>
                  <TextInput
                    value={docDate}
                    onChangeText={setDocDate}
                    style={[resStyles.inlineInput, { backgroundColor: themeColors.inputBg, color: themeColors.text, fontFamily }]}
                    placeholder="ngày ... tháng ... năm ..."
                    placeholderTextColor="#94a3b8"
                  />
                </View>
              ) : (
                <Text style={[resStyles.paperDateText, { color: themeColors.textMuted, fontFamily }]}>Hà Nội, {docDate}</Text>
              )}
            </View>

            {/* Main Title */}
            <View style={resStyles.paperTitleBox}>
              <Text style={[resStyles.paperMainTitle, { color: themeColors.text, fontFamily }]}>BIÊN BẢN CUỘC HỌP</Text>
              {isEditing ? (
                <TextInput
                  value={docTitle}
                  onChangeText={setDocTitle}
                  style={[
                    resStyles.inlineInput,
                    resStyles.paperSubTitleInput,
                    { backgroundColor: themeColors.inputBg, color: themeColors.text, fontFamily },
                  ]}
                  placeholder="Nhập tên cuộc họp..."
                  placeholderTextColor="#94a3b8"
                />
              ) : (
                <Text style={[resStyles.paperSubTitle, { color: themeColors.textMuted, fontFamily }]}>
                  Về việc: {docTitle}
                </Text>
              )}
            </View>

            {/* MỤC I: THÔNG TIN CHUNG */}
            <View style={resStyles.docSection}>
              <Text style={[resStyles.docSectionHead, { color: themeColors.text, borderBottomColor: themeColors.headBorder, fontFamily }]}>
                I. THÔNG TIN CHUNG
              </Text>

              <View style={resStyles.infoRow}>
                <Text style={[resStyles.infoLabel, { color: themeColors.text, fontFamily }]}>1. Thời gian:</Text>
                {isEditing ? (
                  <TextInput
                    value={docTime}
                    onChangeText={setDocTime}
                    style={[resStyles.infoInput, { backgroundColor: themeColors.inputBg, color: themeColors.text, fontFamily }]}
                  />
                ) : (
                  <Text style={[resStyles.infoVal, { color: themeColors.text, fontFamily, fontSize }]}>{docTime}</Text>
                )}
              </View>

              <View style={resStyles.infoRow}>
                <Text style={[resStyles.infoLabel, { color: themeColors.text, fontFamily }]}>2. Địa điểm / Hình thức:</Text>
                {isEditing ? (
                  <TextInput
                    value={docLocation}
                    onChangeText={setDocLocation}
                    style={[resStyles.infoInput, { backgroundColor: themeColors.inputBg, color: themeColors.text, fontFamily }]}
                  />
                ) : (
                  <Text style={[resStyles.infoVal, { color: themeColors.text, fontFamily, fontSize }]}>{docLocation}</Text>
                )}
              </View>

              <View style={resStyles.infoRow}>
                <Text style={[resStyles.infoLabel, { color: themeColors.text, fontFamily }]}>3. Chủ trì cuộc họp:</Text>
                {isEditing ? (
                  <TextInput
                    value={docChair}
                    onChangeText={setDocChair}
                    style={[resStyles.infoInput, { backgroundColor: themeColors.inputBg, color: themeColors.text, fontFamily }]}
                  />
                ) : (
                  <Text style={[resStyles.infoVal, { color: themeColors.text, fontFamily, fontSize }]}>{docChair}</Text>
                )}
              </View>

              <View style={resStyles.infoRow}>
                <Text style={[resStyles.infoLabel, { color: themeColors.text, fontFamily }]}>4. Thư ký ghi biên bản:</Text>
                {isEditing ? (
                  <TextInput
                    value={docSecretary}
                    onChangeText={setDocSecretary}
                    style={[resStyles.infoInput, { backgroundColor: themeColors.inputBg, color: themeColors.text, fontFamily }]}
                  />
                ) : (
                  <Text style={[resStyles.infoVal, { color: themeColors.text, fontFamily, fontSize }]}>{docSecretary}</Text>
                )}
              </View>

              <View style={resStyles.infoRow}>
                <Text style={[resStyles.infoLabel, { color: themeColors.text, fontFamily }]}>5. Thành phần tham dự:</Text>
                {isEditing ? (
                  <TextInput
                    value={docAttendees}
                    onChangeText={setDocAttendees}
                    style={[resStyles.infoInput, { backgroundColor: themeColors.inputBg, color: themeColors.text, fontFamily }]}
                  />
                ) : (
                  <Text style={[resStyles.infoVal, { color: themeColors.text, fontFamily, fontSize }]}>{docAttendees}</Text>
                )}
              </View>
            </View>

            {/* MỤC II: NỘI DUNG DIỄN BIẾN CUỘC HỌP */}
            <View style={resStyles.docSection}>
              <Text style={[resStyles.docSectionHead, { color: themeColors.text, borderBottomColor: themeColors.headBorder, fontFamily }]}>
                II. NỘI DUNG DIỄN BIẾN CUỘC HỌP
              </Text>

              {isEditing ? (
                <View style={resStyles.editorBox}>
                  <Text style={[resStyles.editorHint, { color: themeColors.textMuted }]}>
                    💡 Bạn có thể trực tiếp sửa văn bản bên dưới, dùng thanh công cụ định dạng nhanh trước khi bấm "Lưu thay đổi" hoặc "Tải Biên Bản Word":
                  </Text>
                  <TextInput
                    value={minutesContent}
                    onChangeText={setMinutesContent}
                    multiline
                    style={[
                      resStyles.editorInput,
                      {
                        backgroundColor: themeColors.editorBg,
                        color: themeColors.text,
                        borderColor: themeColors.border,
                        fontFamily,
                        fontSize,
                        lineHeight: Math.round(fontSize * lineHeight * 1.3),
                        textAlign,
                      },
                    ]}
                    textAlignVertical="top"
                  />
                </View>
              ) : (
                <View style={resStyles.minutesRenderBox}>
                  {minutesContent.split("\n").map((line, idx) => {
                    const lineTrim = line.trim();
                    if (!lineTrim) return null;

                    const cleanText = lineTrim
                      .replace(/^#+\s*/gm, "")
                      .replace(/\*\*(.*?)\*\*/g, "$1")
                      .replace(/\*(.*?)\*/g, "$1")
                      .replace(/__(.*?)__/g, "$1")
                      .replace(/_(.*?)_/g, "$1")
                      .trim();

                    // Header sub (I., II., III. hoặc ##)
                    if (lineTrim.startsWith("#") || lineTrim.match(/^[1-9IVX]+\.\s+/)) {
                      return (
                        <Text
                          key={idx}
                          style={[
                            resStyles.paperSubHead,
                            {
                              color: themeColors.text,
                              fontFamily,
                              fontSize: fontSize + 1,
                              textAlign,
                            },
                          ]}
                        >
                          {cleanText}
                        </Text>
                      );
                    }

                    // Bullet item
                    if (lineTrim.startsWith("-") || lineTrim.startsWith("*") || lineTrim.startsWith("•")) {
                      const bullet = cleanText.replace(/^[-*•]\s*/, "");
                      return (
                        <View key={idx} style={resStyles.paperBulletRow}>
                          <Text style={[resStyles.paperBulletDot, { color: themeColors.text, fontFamily }]}>•</Text>
                          <Text
                            style={[
                              resStyles.paperBulletText,
                              {
                                color: themeColors.text,
                                fontFamily,
                                fontSize,
                                lineHeight: Math.round(fontSize * lineHeight * 1.3),
                                textAlign,
                              },
                            ]}
                          >
                            {bullet}
                          </Text>
                        </View>
                      );
                    }

                    // Normal paragraph
                    return (
                      <Text
                        key={idx}
                        style={[
                          resStyles.paperNormalText,
                          {
                            color: themeColors.text,
                            fontFamily,
                            fontSize,
                            lineHeight: Math.round(fontSize * lineHeight * 1.3),
                            textAlign,
                          },
                        ]}
                      >
                        {cleanText}
                      </Text>
                    );
                  })}
                </View>
              )}
            </View>

            {/* MỤC III: BẢNG PHÂN CÔNG NHIỆM VỤ / KẾT LUẬN CHỈ ĐẠO */}
            <View style={resStyles.docSection}>
              <Text style={[resStyles.docSectionHead, { color: themeColors.text, borderBottomColor: themeColors.headBorder, fontFamily }]}>
                III. BẢNG PHÂN CÔNG NHIỆM VỤ / KẾT LUẬN CHỈ ĐẠO
              </Text>

              <View style={[resStyles.tableWrapper, { borderColor: themeColors.tableBorder }]}>
                {/* Table Header */}
                <View style={[resStyles.tableHeaderRow, { backgroundColor: themeColors.tableHeaderBg, borderBottomColor: themeColors.tableBorder }]}>
                  <Text style={[resStyles.thCell, { width: 50, textAlign: "center", color: themeColors.text, borderRightColor: themeColors.tableBorder, fontFamily }]}>STT</Text>
                  <Text style={[resStyles.thCell, { flex: 2, color: themeColors.text, borderRightColor: themeColors.tableBorder, fontFamily }]}>Nội dung công việc / Chỉ đạo</Text>
                  <Text style={[resStyles.thCell, { flex: 1.2, textAlign: "center", color: themeColors.text, borderRightColor: themeColors.tableBorder, fontFamily }]}>Đơn vị / Người phụ trách</Text>
                  <Text style={[resStyles.thCell, { width: 110, textAlign: "center", color: themeColors.text, fontFamily }]}>Thời hạn</Text>
                </View>

                {/* Table Rows */}
                {tasks.length === 0 ? (
                  <View style={resStyles.tableEmptyRow}>
                    <Text style={[resStyles.tableEmptyText, { color: themeColors.textMuted, fontFamily }]}>
                      Không có nhiệm vụ hành động cụ thể nào phát sinh trong cuộc họp.
                    </Text>
                  </View>
                ) : (
                  tasks.map((task, idx) => (
                    <View
                      key={idx}
                      style={[
                        resStyles.tableDataRow,
                        { borderBottomColor: themeColors.tableBorder },
                        idx % 2 === 1 && { backgroundColor: themeColors.tableRowEven },
                      ]}
                    >
                      <Text style={[resStyles.tdCell, { width: 50, textAlign: "center", fontWeight: "700", color: themeColors.text, borderRightColor: themeColors.tableBorder, fontFamily }]}>
                        {idx + 1}
                      </Text>
                      <View style={[resStyles.tdCell, { flex: 2, borderRightColor: themeColors.tableBorder }]}>
                        <Text style={[resStyles.taskCellTitle, { color: themeColors.text, fontFamily }]}>{task.title}</Text>
                        {task.description ? (
                          <Text style={[resStyles.taskCellDesc, { color: themeColors.textMuted, fontFamily }]}>{task.description}</Text>
                        ) : null}
                      </View>
                      <Text style={[resStyles.tdCell, { flex: 1.2, textAlign: "center", color: themeColors.text, borderRightColor: themeColors.tableBorder, fontFamily }]}>
                        {task.assignee_name || "Các đơn vị liên quan"}
                      </Text>
                      <Text style={[resStyles.tdCell, { width: 110, textAlign: "center", color: themeColors.text, fontFamily }]}>
                        {task.due_date || "Kế hoạch sắp tới"}
                      </Text>
                    </View>
                  ))
                )}
              </View>
            </View>

            {/* Phần Chữ ký 2 cột cuối trang */}
            <View style={[resStyles.sigContainer, { borderTopColor: themeColors.border }]}>
              <View style={resStyles.sigCol}>
                <Text style={[resStyles.sigRole, { color: themeColors.text, fontFamily }]}>THƯ KÝ GHI BIÊN BẢN</Text>
                <Text style={[resStyles.sigNote, { color: themeColors.textMuted, fontFamily }]}>(Ký và ghi rõ họ tên)</Text>
                <View style={resStyles.sigSpace} />
                <Text style={[resStyles.sigSigned, { fontFamily }]}><i>(Đã ký điện tử)</i></Text>
                <Text style={[resStyles.sigName, { color: themeColors.text, fontFamily }]}>{docSecretary}</Text>
              </View>

              <View style={resStyles.sigCol}>
                <Text style={[resStyles.sigRole, { color: themeColors.text, fontFamily }]}>CHỦ TRÌ CUỘC HỌP</Text>
                <Text style={[resStyles.sigNote, { color: themeColors.textMuted, fontFamily }]}>(Ký và ghi rõ họ tên)</Text>
                <View style={resStyles.sigSpace} />
                <Text style={[resStyles.sigSigned, { fontFamily }]}><i>(Đã duyệt & ký)</i></Text>
                <Text style={[resStyles.sigName, { color: themeColors.text, fontFamily }]}>{docChair}</Text>
              </View>
            </View>

          </View>
        </View>
      )}

      {/* =====================================================================
          TAB 2: DANH SÁCH NHIỆM VỤ / ACTION ITEMS
      ===================================================================== */}
      {activeTab === "tasks" && (
        <View style={resStyles.card}>
          <View style={resStyles.cardHeaderRow}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons name="checkbox" size={18} color="#818cf8" />
              <Text style={resStyles.cardHeaderTitle}>Nhiệm vụ cuộc họp & Người chịu trách nhiệm</Text>
            </View>
            <Text style={resStyles.taskProgress}>
              Đã hoàn tất {completedTasksCount}/{tasks.length}
            </Text>
          </View>

          {tasks.length === 0 ? (
            <View style={resStyles.emptyTasksBox}>
              <Ionicons name="sparkles-outline" size={32} color="#475569" />
              <Text style={resStyles.emptyTasksText}>Cuộc họp này không phát sinh nhiệm vụ phân công cụ thể.</Text>
            </View>
          ) : (
            <View style={{ gap: 10, marginTop: 14 }}>
              {tasks.map((task, idx) => (
                <Pressable
                  key={task.realId ?? idx}
                  onPress={() => handleToggleTask(idx, task.realId)}
                  style={({ pressed }) => [
                    resStyles.taskItem,
                    task.isDone && resStyles.taskItemDone,
                    pressed && resStyles.btnPressed,
                  ]}
                >
                  <View style={[resStyles.taskCheckbox, task.isDone && resStyles.taskCheckboxDone]}>
                    {task.isDone ? <Ionicons name="checkmark" size={14} color="#ffffff" /> : null}
                  </View>

                  <View style={{ flex: 1 }}>
                    <Text style={[resStyles.taskTitle, task.isDone && resStyles.taskTitleDone]}>
                      {task.title}
                    </Text>
                    {task.description ? (
                      <Text style={resStyles.taskDesc}>{task.description}</Text>
                    ) : null}

                    <View style={resStyles.taskMetaRow}>
                      {task.assignee_name ? (
                        <View style={resStyles.taskMetaTag}>
                          <Ionicons name="person-outline" size={12} color="#818cf8" style={{ marginRight: 4 }} />
                          <Text style={resStyles.taskMetaText}>{task.assignee_name}</Text>
                        </View>
                      ) : null}
                      {task.due_date ? (
                        <View style={resStyles.taskMetaTag}>
                          <Ionicons name="calendar-outline" size={12} color="#fbbf24" style={{ marginRight: 4 }} />
                          <Text style={resStyles.taskMetaText}>{task.due_date}</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      )}

      {/* =====================================================================
          TAB 3: BẢN GỠ BĂNG (TRANSCRIPT) VỚI TÌM KIẾM & CHỈNH SỬA
      ===================================================================== */}
      {activeTab === "transcript" && (
        <View style={{ gap: 14 }}>
          {/* Typography Toolbar cho Transcript */}
          {renderTypographyToolbar()}

          <View style={resStyles.card}>
            {/* Header Toolbar của Transcript */}
            <View style={resStyles.cardHeaderRow}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="mic" size={18} color="#38bdf8" />
                <Text style={resStyles.cardHeaderTitle}>Bản gỡ băng chi tiết (Whisper / Gemini STT)</Text>
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                {/* Nút bật tắt chế độ Sửa Transcript */}
                <Pressable
                  onPress={() => setIsEditingTranscript(!isEditingTranscript)}
                  style={({ pressed }) => [
                    resStyles.copyBtn,
                    isEditingTranscript && { backgroundColor: "rgba(99,102,241,0.25)", borderColor: "#6366f1" },
                    pressed && resStyles.btnPressed,
                  ]}
                >
                  <Ionicons
                    name={isEditingTranscript ? "eye-outline" : "create-outline"}
                    size={14}
                    color={isEditingTranscript ? "#a5b4fc" : "#818cf8"}
                  />
                  <Text style={[resStyles.copyBtnText, isEditingTranscript && { color: "#c7d2fe" }]}>
                    {isEditingTranscript ? "👁️ Đọc văn bản" : "✏️ Sửa bản gỡ băng"}
                  </Text>
                </Pressable>

                {/* Nút Lưu Transcript vào DB */}
                {isEditingTranscript && (
                  <Pressable
                    onPress={handleSaveTranscriptToDB}
                    disabled={isSavingTranscript}
                    style={({ pressed }) => [resStyles.copyBtn, { backgroundColor: "rgba(52,211,153,0.15)" }, pressed && resStyles.btnPressed]}
                  >
                    {isSavingTranscript ? (
                      <ActivityIndicator size="small" color="#34d399" />
                    ) : (
                      <Ionicons
                        name={savedTranscriptToast ? "checkmark-circle" : "save-outline"}
                        size={14}
                        color="#34d399"
                      />
                    )}
                    <Text style={[resStyles.copyBtnText, { color: "#34d399" }]}>
                      {savedTranscriptToast ? "Đã lưu!" : "💾 Lưu bản gỡ"}
                    </Text>
                  </Pressable>
                )}

                {/* Nút Sao chép */}
                <Pressable
                  onPress={() => handleCopyText(transcriptContent)}
                  style={({ pressed }) => [resStyles.copyBtn, pressed && resStyles.btnPressed]}
                >
                  <Ionicons name={copied ? "checkmark-circle" : "copy-outline"} size={14} color="#818cf8" />
                  <Text style={resStyles.copyBtnText}>{copied ? "Đã sao chép!" : "Sao chép"}</Text>
                </Pressable>
              </View>
            </View>

            {/* Thanh Tìm Kiếm Từ Khóa trong Transcript */}
            <View style={resStyles.searchBarRow}>
              <View style={resStyles.searchInputBox}>
                <Ionicons name="search" size={16} color="#64748b" style={{ marginRight: 8 }} />
                <TextInput
                  value={transcriptSearch}
                  onChangeText={setTranscriptSearch}
                  placeholder="🔍 Tìm trong bản gỡ băng... (VD: kinh tế, dự án, kết luận...)"
                  placeholderTextColor="#64748b"
                  style={resStyles.searchInput}
                />
                {transcriptSearch.length > 0 ? (
                  <Pressable onPress={() => setTranscriptSearch("")} style={{ padding: 4 }}>
                    <Ionicons name="close-circle" size={16} color="#94a3b8" />
                  </Pressable>
                ) : null}
              </View>

              {transcriptSearch.trim().length > 0 ? (
                <View style={resStyles.searchCountBadge}>
                  <Text style={resStyles.searchCountText}>
                    {transcriptMatchCount > 0
                      ? `🎯 Tìm thấy ${transcriptMatchCount} lần xuất hiện`
                      : "Không tìm thấy kết quả"}
                  </Text>
                </View>
              ) : null}
            </View>

            {/* Khung Hiển Thị Văn Bản Bóc Băng */}
            <View
              style={[
                resStyles.textBox,
                {
                  backgroundColor: themeColors.bg,
                  borderColor: themeColors.border,
                },
              ]}
            >
              {isEditingTranscript ? (
                <TextInput
                  value={transcriptContent}
                  onChangeText={setTranscriptContent}
                  multiline
                  style={[
                    resStyles.transcriptInput,
                    {
                      color: themeColors.text,
                      fontFamily,
                      fontSize,
                      lineHeight: Math.round(fontSize * lineHeight * 1.3),
                      textAlign,
                    },
                  ]}
                  textAlignVertical="top"
                />
              ) : (
                <View>
                  {(() => {
                    const fullText = transcriptContent || "Không có nội dung bóc băng.";
                    if (!transcriptSearch.trim()) {
                      return (
                        <Text
                          style={[
                            resStyles.transcriptText,
                            {
                              color: themeColors.text,
                              fontFamily,
                              fontSize,
                              lineHeight: Math.round(fontSize * lineHeight * 1.3),
                              textAlign,
                            },
                          ]}
                        >
                          {fullText}
                        </Text>
                      );
                    }

                    // Tách và highlight từ khóa
                    try {
                      const escaped = transcriptSearch.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                      const parts = fullText.split(new RegExp(`(${escaped})`, "gi"));
                      return (
                        <Text
                          style={[
                            resStyles.transcriptText,
                            {
                              color: themeColors.text,
                              fontFamily,
                              fontSize,
                              lineHeight: Math.round(fontSize * lineHeight * 1.3),
                              textAlign,
                            },
                          ]}
                        >
                          {parts.map((part, pIdx) => {
                            const isMatch = part.toLowerCase() === transcriptSearch.trim().toLowerCase();
                            if (isMatch) {
                              return (
                                <Text
                                  key={pIdx}
                                  style={{
                                    backgroundColor: "#FEF08A",
                                    color: "#854D0E",
                                    fontWeight: "800",
                                    paddingHorizontal: 2,
                                  }}
                                >
                                  {part}
                                </Text>
                              );
                            }
                            return <Text key={pIdx}>{part}</Text>;
                          })}
                        </Text>
                      );
                    } catch {
                      return <Text style={resStyles.transcriptText}>{fullText}</Text>;
                    }
                  })()}
                </View>
              )}
            </View>
          </View>
        </View>
      )}

    </Animated.View>
  );
}

// ===========================================================================
// STYLES CHO RESULT DASHBOARD & KHUNG BIỂU MẪU CHUẨN
// ===========================================================================
const resStyles = StyleSheet.create({
  topBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#111827",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(52,211,153,0.2)",
    marginBottom: 16,
    flexWrap: "wrap",
    gap: 12,
  },
  topBannerLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  successCircle: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(52,211,153,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  topBannerTitle: { color: "#f8fafc", fontSize: 16, fontWeight: "800" },
  topBannerSub: { color: "#94a3b8", fontSize: 12, marginTop: 2 },
  newRecBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(99,102,241,0.12)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(99,102,241,0.25)",
  },
  newRecBtnText: { color: "#a5b4fc", fontSize: 12, fontWeight: "700" },

  tabsRow: { flexDirection: "row", gap: 8, marginBottom: 14, flexWrap: "wrap" },
  tabBtn: {
    flex: 1,
    minWidth: 120,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "#111827",
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  tabBtnActive: { backgroundColor: "rgba(99,102,241,0.16)", borderColor: "#6366f1" },
  tabText: { color: "#94a3b8", fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: "#a5b4fc", fontWeight: "800" },

  /* AI Text Studio */
  aiStudioCard: {
    backgroundColor: "#111827",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(99,102,241,0.35)",
    gap: 12,
  },
  aiStudioHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  aiSparkleIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: "rgba(99,102,241,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  aiStudioTitle: { color: "#f8fafc", fontSize: 14, fontWeight: "800" },
  aiStudioSub: { color: "#94a3b8", fontSize: 11, marginTop: 2 },
  aiLoadingBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(99,102,241,0.15)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(99,102,241,0.3)",
  },
  aiLoadingText: { color: "#a5b4fc", fontSize: 11, fontWeight: "700" },
  aiPresetsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  aiPresetBtn: {
    flex: 1,
    minWidth: 130,
    backgroundColor: "#0F172A",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  aiPresetBtnActive: {
    backgroundColor: "rgba(99,102,241,0.2)",
    borderColor: "#6366f1",
  },
  aiPresetLabel: { color: "#f8fafc", fontSize: 12, fontWeight: "700" },
  aiPresetDesc: { color: "#64748b", fontSize: 10, marginTop: 2 },
  aiPromptBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#0F172A",
    borderRadius: 10,
    padding: 6,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  aiPromptInput: {
    flex: 1,
    color: "#f8fafc",
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  aiPromptSubmitBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#4f46e5",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  aiPromptSubmitText: { color: "#ffffff", fontSize: 12, fontWeight: "700" },

  /* Typography Toolbar */
  typoCard: {
    backgroundColor: "#111827",
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    gap: 10,
  },
  typoRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 12,
  },
  typoGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  typoLabel: { color: "#94a3b8", fontSize: 12, fontWeight: "700" },
  fontPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  fontPillActive: {
    backgroundColor: "#4f46e5",
    borderColor: "#6366f1",
  },
  fontPillText: { color: "#cbd5e1", fontSize: 12, fontWeight: "600" },
  fontPillTextActive: { color: "#ffffff", fontWeight: "800" },
  fontPillNote: { color: "#64748b", fontSize: 10 },
  themePill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  themePillActive: {
    backgroundColor: "rgba(99,102,241,0.2)",
    borderColor: "#6366f1",
  },
  themePillText: { color: "#cbd5e1", fontSize: 12, fontWeight: "600" },
  themePillTextActive: { color: "#a5b4fc", fontWeight: "800" },

  sizeStepperBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#1e293b",
    alignItems: "center",
    justifyContent: "center",
  },
  sizeStepperText: { color: "#cbd5e1", fontSize: 12, fontWeight: "700" },
  sizePill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  sizePillActive: { backgroundColor: "#4f46e5", borderColor: "#6366f1" },
  sizePillText: { color: "#94a3b8", fontSize: 11, fontWeight: "600" },
  sizePillTextActive: { color: "#ffffff", fontWeight: "800" },

  spacingPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  spacingPillActive: { backgroundColor: "rgba(99,102,241,0.2)", borderColor: "#6366f1" },
  spacingPillText: { color: "#94a3b8", fontSize: 11, fontWeight: "600" },
  spacingPillTextActive: { color: "#a5b4fc", fontWeight: "800" },

  alignBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  alignBtnActive: { backgroundColor: "rgba(99,102,241,0.2)", borderColor: "#6366f1" },
  alignBtnText: { color: "#94a3b8", fontSize: 11, fontWeight: "600" },

  /* Quick Formatting Bar */
  quickFormatCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#0F172A",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#1e293b",
    flexWrap: "wrap",
    gap: 8,
  },
  quickFormatLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  quickFormatLabel: { color: "#818cf8", fontSize: 12, fontWeight: "700", marginRight: 4 },
  qfBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  qfBtnText: { color: "#f8fafc", fontSize: 12 },
  undoResetBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "rgba(248,113,113,0.1)",
    borderWidth: 1,
    borderColor: "rgba(248,113,113,0.3)",
  },
  undoResetText: { color: "#f87171", fontSize: 11, fontWeight: "700" },

  /* Action Toolbar */
  toolbarCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#111827",
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    flexWrap: "wrap",
    gap: 10,
  },
  toolbarLeft: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  toolbarRight: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },

  wordDownloadBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#4f46e5",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
  },
  wordDownloadBtnText: { color: "#ffffff", fontSize: 13, fontWeight: "800" },

  toolBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0F172A",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  toolBtnActive: {
    backgroundColor: "rgba(99,102,241,0.15)",
    borderColor: "rgba(99,102,241,0.4)",
  },
  toolBtnText: { color: "#cbd5e1", fontSize: 12, fontWeight: "600" },

  /* Official Paper Sheet Preview (Trang giấy chuẩn Nghị định 30) */
  paperSheet: {
    borderRadius: 8,
    padding: Platform.OS === "web" ? 36 : 18,
    borderWidth: 1,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 4,
  },

  paperHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 1,
    paddingBottom: 14,
    marginBottom: 12,
  },
  paperHeaderLeft: { flex: 1, alignItems: "center" },
  paperOrgName: { fontSize: 12, fontWeight: "800", textTransform: "uppercase" },
  paperDocNo: { fontSize: 11, marginTop: 3 },

  paperHeaderRight: { flex: 1.2, alignItems: "center" },
  paperNationName: { fontSize: 12, fontWeight: "800", textTransform: "uppercase" },
  paperMotto: { fontSize: 13, fontWeight: "700", marginTop: 2 },
  paperMottoLine: { fontSize: 10, letterSpacing: -1, marginTop: -2 },

  paperDateRow: { alignItems: "flex-end", marginBottom: 16 },
  paperDateText: { fontSize: 12, fontStyle: "italic" },
  paperDateLabel: { fontSize: 12, fontStyle: "italic" },

  paperTitleBox: { alignItems: "center", marginBottom: 20 },
  paperMainTitle: { fontSize: 18, fontWeight: "900", letterSpacing: 0.5 },
  paperSubTitle: { fontSize: 13, fontWeight: "700", fontStyle: "italic", marginTop: 4 },
  paperSubTitleInput: {
    textAlign: "center",
    fontWeight: "700",
    fontStyle: "italic",
    fontSize: 13,
    minWidth: 260,
    marginTop: 4,
  },

  docSection: { marginBottom: 20 },
  docSectionHead: {
    fontSize: 14,
    fontWeight: "800",
    textTransform: "uppercase",
    borderBottomWidth: 1,
    paddingBottom: 4,
    marginBottom: 10,
  },

  infoRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 6, flexWrap: "wrap" },
  infoLabel: { width: 180, fontSize: 13, fontWeight: "700" },
  infoVal: { flex: 1, lineHeight: 20 },
  infoInput: {
    flex: 1,
    fontSize: 13,
    borderWidth: 1,
    borderColor: "#94a3b8",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  inlineInput: {
    borderWidth: 1,
    borderColor: "#94a3b8",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 12,
  },

  /* Editor Box */
  editorBox: { marginTop: 8 },
  editorHint: { fontSize: 12, fontStyle: "italic", marginBottom: 8 },
  editorInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    minHeight: 280,
  },

  /* Rendered Minutes */
  minutesRenderBox: { paddingHorizontal: 4 },
  paperSubHead: { fontWeight: "800", marginTop: 12, marginBottom: 4 },
  paperBulletRow: { flexDirection: "row", alignItems: "flex-start", marginLeft: 16, marginBottom: 4 },
  paperBulletDot: { fontSize: 14, marginRight: 8, lineHeight: 20 },
  paperBulletText: { flex: 1 },
  paperNormalText: { marginBottom: 8, paddingLeft: 8 },

  /* Table */
  tableWrapper: {
    borderWidth: 1,
    borderRadius: 4,
    overflow: "hidden",
    marginTop: 6,
  },
  tableHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
  },
  thCell: {
    padding: 8,
    fontSize: 12,
    fontWeight: "800",
    borderRightWidth: 1,
  },
  tableDataRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    alignItems: "center",
  },
  tdCell: {
    padding: 8,
    fontSize: 12,
    borderRightWidth: 1,
  },
  taskCellTitle: { fontSize: 12, fontWeight: "700" },
  taskCellDesc: { fontSize: 11, fontStyle: "italic", marginTop: 2 },
  tableEmptyRow: { padding: 16, alignItems: "center" },
  tableEmptyText: { fontSize: 12, fontStyle: "italic" },

  /* Signatures */
  sigContainer: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 32,
    paddingTop: 16,
    borderTopWidth: 1,
  },
  sigCol: { alignItems: "center", flex: 1 },
  sigRole: { fontSize: 13, fontWeight: "800", textTransform: "uppercase" },
  sigNote: { fontSize: 11, fontStyle: "italic", marginTop: 2 },
  sigSpace: { height: 60 },
  sigSigned: { color: "#10b981", fontSize: 11, fontStyle: "italic" },
  sigName: { fontSize: 13, fontWeight: "700", marginTop: 4 },

  /* Common Card for Tab 2 & 3 */
  card: {
    backgroundColor: "#111827",
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
    flexWrap: "wrap",
    gap: 8,
  },
  cardHeaderTitle: { color: "#f8fafc", fontSize: 15, fontWeight: "700" },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(99,102,241,0.12)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "transparent",
  },
  copyBtnText: { color: "#a5b4fc", fontSize: 12, fontWeight: "600" },

  /* Search bar trong Transcript */
  searchBarRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    marginBottom: 4,
    flexWrap: "wrap",
    gap: 8,
  },
  searchInputBox: {
    flex: 1,
    minWidth: 260,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0F172A",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  searchInput: {
    flex: 1,
    color: "#f8fafc",
    fontSize: 13,
    padding: 0,
  },
  searchCountBadge: {
    backgroundColor: "rgba(254,240,138,0.15)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(254,240,138,0.3)",
  },
  searchCountText: {
    color: "#fef08a",
    fontSize: 12,
    fontWeight: "700",
  },

  textBox: {
    marginTop: 12,
    padding: 18,
    borderRadius: 12,
    borderWidth: 1,
  },
  transcriptText: {
    fontSize: 13,
    lineHeight: 22,
  },
  transcriptInput: {
    minHeight: 280,
    padding: 0,
  },

  taskProgress: { color: "#34d399", fontSize: 12, fontWeight: "700" },
  emptyTasksBox: { alignItems: "center", justifyContent: "center", paddingVertical: 36 },
  emptyTasksText: { color: "#64748b", fontSize: 13, marginTop: 8, textAlign: "center" },
  taskItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  taskItemDone: { backgroundColor: "rgba(52,211,153,0.05)", borderColor: "rgba(52,211,153,0.2)" },
  taskCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#475569",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  taskCheckboxDone: { backgroundColor: "#34d399", borderColor: "#34d399" },
  taskTitle: { color: "#f8fafc", fontSize: 14, fontWeight: "600", lineHeight: 20 },
  taskTitleDone: { color: "#64748b", textDecorationLine: "line-through" },
  taskDesc: { color: "#94a3b8", fontSize: 12, lineHeight: 18, marginTop: 4 },
  taskMetaRow: { flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" },
  taskMetaTag: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  taskMetaText: { color: "#cbd5e1", fontSize: 11, fontWeight: "500" },
  btnPressed: { opacity: 0.8 },
});
const s = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#090D16" },
  loadingContainer: { flex: 1, backgroundColor: "#090D16", alignItems: "center", justifyContent: "center" },
  loadingText: { color: "#94a3b8", fontSize: 14, marginTop: 12 },
  mainContainer: { flex: 1, width: "100%", maxWidth: 1200, alignSelf: "center" },

  /* Nav */
  navBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" },
  navLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  backButton: { width: 38, height: 38, borderRadius: 10, backgroundColor: "#111827", borderWidth: 1, borderColor: "#1e293b", alignItems: "center", justifyContent: "center" },
  navTitleBox: { flex: 1 },
  navTitle: { color: "#f8fafc", fontSize: 18, fontWeight: "800" },
  idBadge: { backgroundColor: "rgba(99,102,241,0.2)", paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, borderWidth: 1, borderColor: "rgba(99,102,241,0.3)" },
  idBadgeText: { color: "#a5b4fc", fontSize: 11, fontWeight: "700" },
  navSubtitle: { color: "#64748b", fontSize: 12, marginTop: 2 },
  navRight: { flexDirection: "row", alignItems: "center" },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: "#111827", borderWidth: 1, borderColor: "#1e293b" },
  statusPillRec: { backgroundColor: "rgba(248,113,113,0.15)", borderColor: "rgba(248,113,113,0.35)" },
  statusPillProc: { backgroundColor: "rgba(251,191,36,0.15)", borderColor: "rgba(251,191,36,0.35)" },
  statusPillDone: { backgroundColor: "rgba(52,211,153,0.15)", borderColor: "rgba(52,211,153,0.35)" },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#64748b" },
  statusPillText: { color: "#cbd5e1", fontSize: 12, fontWeight: "600" },

  /* Layout */
  scrollContent: { padding: 20, paddingBottom: 60 },
  grid: { flexDirection: Platform.OS === "web" ? "row" : "column", alignItems: "flex-start", gap: 20 },
  leftCol: { width: Platform.OS === "web" ? 380 : "100%", flexShrink: 0 },
  rightCol: { flex: 1, minWidth: 0, width: "100%" },

  /* Control Card */
  controlCard: { backgroundColor: "#111827", borderRadius: 20, padding: 24, borderWidth: 1, borderColor: "rgba(255,255,255,0.08)", alignItems: "center" },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  heroLabel: { color: "#818cf8", fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  timerText: { color: "#475569", fontSize: 54, fontWeight: "900", letterSpacing: -1 },
  timerActive: { color: "#f8fafc" },
  timerHint: { color: "#64748b", fontSize: 13, marginBottom: 24 },

  /* Mic Button */
  micWrap: { alignItems: "center", justifyContent: "center", marginBottom: 24, position: "relative" },
  micPulse: { position: "absolute", width: 170, height: 170, borderRadius: 85, borderWidth: 2, borderColor: "rgba(248,113,113,0.3)", backgroundColor: "rgba(248,113,113,0.06)" },
  micAura: { position: "absolute", width: 140, height: 140, borderRadius: 70, backgroundColor: "rgba(99,102,241,0.08)", borderWidth: 1, borderColor: "rgba(99,102,241,0.2)" },
  micAuraActive: { backgroundColor: "rgba(248,113,113,0.12)", borderColor: "rgba(248,113,113,0.35)" },
  micBtn: { width: 110, height: 110, borderRadius: 55, backgroundColor: "#4f46e5", alignItems: "center", justifyContent: "center", shadowColor: "#6366f1", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.5, shadowRadius: 18 },
  micBtnActive: { backgroundColor: "#ef4444", shadowColor: "#ef4444" },

  /* Action Buttons */
  recActionBtn: { width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "center", paddingVertical: 14, borderRadius: 14, marginBottom: 16 },
  recActionStart: { backgroundColor: "#4f46e5" },
  recActionStop: { backgroundColor: "#ef4444" },
  recActionText: { color: "#ffffff", fontSize: 15, fontWeight: "700" },

  /* Divider */
  dividerRow: { flexDirection: "row", alignItems: "center", width: "100%", marginBottom: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "rgba(255,255,255,0.08)" },
  dividerText: { color: "#475569", fontSize: 11, fontWeight: "700", paddingHorizontal: 12 },

  /* Upload */
  uploadBtn: { width: "100%", flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 14, backgroundColor: "#0F172A", borderWidth: 1, borderColor: "#1e293b", marginBottom: 12 },
  uploadIconCircle: { width: 36, height: 36, borderRadius: 10, backgroundColor: "rgba(99,102,241,0.15)", alignItems: "center", justifyContent: "center" },
  uploadTitle: { color: "#f8fafc", fontSize: 13, fontWeight: "700" },
  uploadSub: { color: "#64748b", fontSize: 11, marginTop: 2 },
  selectedFileBox: { flexDirection: "row", alignItems: "center", gap: 8, width: "100%", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: "rgba(99,102,241,0.08)", borderWidth: 1, borderColor: "rgba(99,102,241,0.2)", marginBottom: 12 },
  selectedFileName: { flex: 1, color: "#a5b4fc", fontSize: 12, fontWeight: "600" },
  selectedFileSize: { color: "#64748b", fontSize: 11 },

  /* Features */
  featureBox: { width: "100%", gap: 8 },
  featurePill: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.03)" },
  featurePillText: { color: "#94a3b8", fontSize: 12, fontWeight: "500" },

  /* Idle */
  idleCard: { backgroundColor: "#111827", borderRadius: 20, padding: 32, borderWidth: 1, borderColor: "rgba(255,255,255,0.08)", alignItems: "center" },
  idleIconBox: { width: 72, height: 72, borderRadius: 22, backgroundColor: "rgba(99,102,241,0.15)", borderWidth: 1, borderColor: "rgba(99,102,241,0.3)", alignItems: "center", justifyContent: "center", marginBottom: 16 },
  idleTitle: { color: "#f8fafc", fontSize: 20, fontWeight: "800", marginBottom: 8 },
  idleSub: { color: "#94a3b8", fontSize: 14, textAlign: "center", lineHeight: 22, maxWidth: 520, marginBottom: 28 },
  capList: { width: "100%", gap: 16 },
  capItem: { flexDirection: "row", alignItems: "flex-start", gap: 14, padding: 16, borderRadius: 14, backgroundColor: "#0F172A", borderWidth: 1, borderColor: "#1e293b" },
  capBullet: { width: 36, height: 36, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.04)", alignItems: "center", justifyContent: "center" },
  capHead: { color: "#f8fafc", fontSize: 14, fontWeight: "700", marginBottom: 4 },
  capBody: { color: "#94a3b8", fontSize: 12, lineHeight: 18 },

  /* Recording Feedback */
  recFeedbackCard: { backgroundColor: "#111827", borderRadius: 20, padding: 40, borderWidth: 1, borderColor: "rgba(248,113,113,0.2)", alignItems: "center" },
  waveContainer: { flexDirection: "row", alignItems: "center", justifyContent: "center", height: 40, marginBottom: 20 },
  recFeedTitle: { color: "#f8fafc", fontSize: 18, fontWeight: "800", marginBottom: 6 },
  recFeedSub: { color: "#94a3b8", fontSize: 13, textAlign: "center", lineHeight: 20, maxWidth: 420 },

  /* Error */
  errorCard: { backgroundColor: "#111827", borderRadius: 20, padding: 32, borderWidth: 1, borderColor: "rgba(248,113,113,0.3)", alignItems: "center" },
  errorIconBox: { width: 64, height: 64, borderRadius: 20, backgroundColor: "rgba(248,113,113,0.15)", alignItems: "center", justifyContent: "center", marginBottom: 14 },
  errorTitle: { color: "#f87171", fontSize: 18, fontWeight: "800", marginBottom: 6 },
  errorMsg: { color: "#f8fafc", fontSize: 14, fontWeight: "600", textAlign: "center", marginBottom: 4 },
  errorDtl: { color: "#94a3b8", fontSize: 12, textAlign: "center", lineHeight: 18, marginBottom: 20 },
  retryBtn: { flexDirection: "row", alignItems: "center", backgroundColor: "#4f46e5", paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 },
  retryBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },

  btnPressed: { opacity: 0.8 },
});

/* Processing Styles */
const procStyles = StyleSheet.create({
  container: { backgroundColor: "#111827", borderRadius: 20, padding: 28, borderWidth: 1, borderColor: "rgba(255,255,255,0.08)", alignItems: "center" },
  ringBox: { width: 100, height: 100, alignItems: "center", justifyContent: "center", marginBottom: 20, position: "relative" },
  staticRing: { width: 100, height: 100, borderRadius: 50, borderWidth: 3, borderColor: "rgba(99,102,241,0.15)" },
  spinRing: { position: "absolute", width: 100, height: 100, borderRadius: 50, borderWidth: 3, borderColor: "transparent", borderTopColor: "#6366f1", borderRightColor: "#8b5cf6" },
  centerPercent: { position: "absolute", alignItems: "center", justifyContent: "center" },
  percentText: { color: "#f8fafc", fontSize: 22, fontWeight: "900" },
  title: { color: "#f8fafc", fontSize: 18, fontWeight: "800", marginBottom: 4 },
  detail: { color: "#94a3b8", fontSize: 13, textAlign: "center", maxWidth: 440, lineHeight: 20, marginBottom: 16 },
  progressBarBg: { width: "100%", height: 6, borderRadius: 3, backgroundColor: "rgba(99,102,241,0.15)", marginBottom: 20, overflow: "hidden" },
  progressBarFill: { height: 6, borderRadius: 3, backgroundColor: "#6366f1" },
  stepList: { width: "100%", gap: 10, marginBottom: 16 },
  stepItem: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#0F172A", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "#1e293b" },
  stepItemActive: { borderColor: "rgba(99,102,241,0.4)", backgroundColor: "rgba(99,102,241,0.05)" },
  stepCircle: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#1e293b", alignItems: "center", justifyContent: "center" },
  stepCircleActive: { backgroundColor: "rgba(99,102,241,0.2)", borderWidth: 1, borderColor: "#6366f1" },
  stepCircleDone: { backgroundColor: "#34d399", borderColor: "#34d399" },
  stepNum: { color: "#64748b", fontSize: 12, fontWeight: "700" },
  stepTitle: { color: "#f8fafc", fontSize: 13, fontWeight: "700" },
  stepSub: { color: "#64748b", fontSize: 11, marginTop: 2 },
  liveTranscriptBox: { width: "100%", backgroundColor: "#0F172A", borderRadius: 14, borderWidth: 1, borderColor: "#1e293b", overflow: "hidden" },
  liveTranscriptHeader: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#1e293b" },
  liveTranscriptTitle: { color: "#a5b4fc", fontSize: 12, fontWeight: "700", flex: 1 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#34d399" },
  liveTranscriptScroll: { maxHeight: 200, padding: 14 },
  liveTranscriptText: { color: "#cbd5e1", fontSize: 12, lineHeight: 20, fontFamily: Platform.OS === "web" ? "monospace" : undefined },
});
