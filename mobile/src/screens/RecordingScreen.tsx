/**
 * src/screens/RecordingScreen.tsx
 *
 * Studio Thu Âm & Soạn Thảo Biên Bản – VietMeeting AI
 * Thiết kế theo chuẩn Human-Crafted UI:
 * - Zero-Emoji UI Policy (Feather Vector Icons)
 * - Swiss Editorial & Linear Palette (Neutral Slate / Zinc & Administrative Navy)
 * - Bảng điều khiển thu âm phong cách Sony/Zoom Digital Recorder
 * - Khung soạn thảo Ribbon Office & Xem trước trang giấy A4 chuẩn thể thức
 * - Tiến trình xử lý AI dạng Technical Stepper
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
import { Feather } from "@expo/vector-icons";
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
import type {
  AIProcessingResult,
  AIRewriteMode,
  APIErrorResponse,
  FontFamilyType,
  MeetingRead,
  PaperThemeType,
  ProgressData,
  RecordingScreenState,
  RootStackParamList,
  TextAlignType,
} from "@/types/meeting";

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
  const [localAudioUrl, setLocalAudioUrl] = useState<string>("");

  // Ghi chú trọng tâm của Thư ký (Granola-style hybrid notes)
  const [secretaryNotes, setSecretaryNotes] = useState<string>("");

  // Progress tracking
  const [progressData, setProgressData] = useState<ProgressData | null>(null);
  const progressPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Active Result Tab: "minutes" | "tasks" | "transcript" | "copilot"
  const [activeTab, setActiveTab] = useState<"minutes" | "tasks" | "transcript" | "copilot">("minutes");

  // Modal cấu hình AI
  const [aiConfigModalVisible, setAiConfigModalVisible] = useState(false);

  // Refs
  const recordingRef = useRef<Audio.Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Animations
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;
  const dotAnim = useRef(new Animated.Value(1)).current;

  // Pulse animation for recording
  const startPulse = useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.12, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
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
        Animated.timing(dotAnim, { toValue: 0.25, duration: 600, useNativeDriver: true }),
        Animated.timing(dotAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])
    ).start();
  }, [dotAnim]);

  const animateResultIn = useCallback(() => {
    fadeAnim.setValue(0);
    slideAnim.setValue(20);
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, slideAnim]);

  // Progress Polling
  const startProgressPolling = useCallback(() => {
    stopProgressPolling();
    progressPollRef.current = setInterval(async () => {
      try {
        const res = await axios.get<ProgressData>(
          API_ENDPOINTS.getProgress(meetingId),
          { timeout: 5000 }
        );
        setProgressData(res.data);

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
      setErrorDetail("Vui lòng kiểm tra kết nối với máy chủ.");
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
          "Yêu cầu quyền Microphone",
          "VietMeeting AI cần quyền truy cập Microphone để ghi âm trực tiếp. Bạn cũng có thể tải lên tệp âm thanh có sẵn.",
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
          ? "Quyền truy cập Microphone bị từ chối."
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
      if (!audioUri) throw new Error("Không lấy được đường dẫn tệp âm thanh.");
      setLocalAudioUrl(audioUri);
    } catch (error) {
      setErrorMessage("Không thể lưu tệp ghi âm.");
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

          setSelectedFileName(file.name);
          setSelectedFileSize(`${(file.size / (1024 * 1024)).toFixed(1)} MB`);
          try {
            const objUrl = URL.createObjectURL(file);
            setLocalAudioUrl(objUrl);
          } catch {}

          setResult(null);
          setErrorMessage("");
          setErrorDetail("");
          setProgressData(null);
          setScreenState("processing");
          startProgressPolling();

          try {
            const formData = new FormData();
            formData.append("file", file, file.name);
            if (secretaryNotes.trim()) {
              formData.append("notes", secretaryNotes.trim());
            }
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
        "Tải lên tệp âm thanh",
        "Trên thiết bị di động, vui lòng sử dụng tính năng Ghi âm trực tiếp hoặc cài đặt thêm công cụ chọn tệp.",
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

      if (secretaryNotes.trim()) {
        formData.append("notes", secretaryNotes.trim());
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
    let userMessage = "Không thể kết nối đến máy chủ AI.";
    let detail = "";

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<APIErrorResponse>;
      if (axiosError.code === "ECONNABORTED") {
        userMessage = "Quá thời gian chờ xử lý AI (Timeout).";
        detail = "Tệp âm thanh có thể quá dài. Vui lòng thử đoạn ghi âm ngắn hơn.";
      } else if (axiosError.code === "ECONNREFUSED" || axiosError.message.includes("Network Error")) {
        userMessage = "Mất kết nối với Backend.";
        detail = "Vui lòng đảm bảo FastAPI và engine AI đang hoạt động bình thường.";
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
            userMessage = serverMessage || "Định dạng tệp âm thanh không được hỗ trợ.";
            detail = serverDetail || "Hệ thống hỗ trợ các định dạng .wav, .mp3, .m4a, .webm, .flac.";
            break;
          case 404:
            userMessage = serverMessage || `Không tìm thấy cuộc họp mã số #${meetingId}.`;
            detail = serverDetail || "Vui lòng quay lại màn hình chính và khởi tạo cuộc họp mới.";
            break;
          case 422:
            userMessage = serverMessage || "Không nhận diện được giọng nói trong âm thanh.";
            detail = serverDetail || "Tệp âm thanh quá nhỏ hoặc bị nhiễu không rõ tiếng nói.";
            break;
          case 503:
            userMessage = serverMessage || "Dịch vụ AI tạm thời gián đoạn (HTTP 503).";
            detail = serverDetail || "Vui lòng kiểm tra tiến trình mô hình AI hoặc tài nguyên máy tính.";
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

  if (isLoadingHistory) {
    return (
      <SafeAreaView style={s.loadingContainer}>
        <ActivityIndicator size="small" color="#2563EB" />
        <Text style={s.loadingText}>Đang đọc dữ liệu biên bản cuộc họp...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#0C0E12" />
      <View style={s.mainContainer}>

        {/* ================================================================
            TOP NAVIGATION BAR
        ================================================================ */}
        <View style={s.navBar}>
          <View style={s.navLeft}>
            <Pressable
              onPress={() => navigation.goBack()}
              hitSlop={8}
              style={({ pressed }) => [s.backButton, pressed && s.btnPressed]}
            >
              <Feather name="arrow-left" size={18} color="#94A3B8" />
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
                  ? "Biên bản & Bảng phân công nhiệm vụ đã hoàn tất"
                  : "Studio ghi âm & xử lý ngôn ngữ tự nhiên"}
              </Text>
            </View>
          </View>

          <View style={s.navRight}>
            <AIEngineBadge onPress={() => setAiConfigModalVisible(true)} />

            <View style={[
              s.statusPill,
              screenState === "recording" && s.statusPillRec,
              screenState === "processing" && s.statusPillProc,
              screenState === "success" && s.statusPillDone,
            ]}>
              <View style={[
                s.statusDot,
                screenState === "recording" && { backgroundColor: "#EF4444" },
                screenState === "processing" && { backgroundColor: "#F59E0B" },
                screenState === "success" && { backgroundColor: "#10B981" },
              ]} />
              <Text style={s.statusPillText}>
                {screenState === "recording"
                  ? "Đang ghi âm"
                  : screenState === "processing"
                  ? "Đang phân tích AI"
                  : screenState === "success"
                  ? "Hoàn tất"
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

            {/* ── CỘT TRÁI: Thiết bị thu âm chuyên dụng (Sony/Zoom Recorder) ── */}
            <View style={s.leftCol}>
              <View style={s.recorderCard}>

                {/* Recorder Header & LED indicator */}
                <View style={s.recorderHeader}>
                  <View style={s.recorderBrand}>
                    <Feather name="disc" size={13} color="#64748B" />
                    <Text style={s.recorderBrandText}>DIGITAL AUDIO RECORDER</Text>
                  </View>
                  <View style={s.ledRow}>
                    <Animated.View style={[
                      s.ledIndicator,
                      {
                        backgroundColor: screenState === "recording" ? "#EF4444" : "#10B981",
                        opacity: screenState === "recording" ? dotAnim : 1,
                      }
                    ]} />
                    <Text style={s.ledText}>
                      {screenState === "recording" ? "REC" : "STBY"}
                    </Text>
                  </View>
                </View>

                {/* Big Tabular Digital Counter */}
                <View style={s.timerDisplay}>
                  <Text style={[
                    s.timerText,
                    screenState === "recording" && s.timerActive
                  ]}>
                    {formattedTime}
                  </Text>
                  <Text style={s.timerSubtext}>
                    {screenState === "recording" ? "ĐANG THU ÂM TRỰC TIẾP (16kHz PCM)" : "THỜI LƯỢNG GHI ÂM"}
                  </Text>
                </View>

                {/* Record Button */}
                <View style={s.micWrap}>
                  {screenState === "recording" && (
                    <Animated.View style={[
                      s.micPulse,
                      { transform: [{ scale: pulseAnim }] }
                    ]} />
                  )}
                  <Pressable
                    onPress={screenState === "recording" ? handleStopRecording : handleStartRecording}
                    style={({ pressed }) => [
                      s.micBtn,
                      screenState === "recording" && s.micBtnActive,
                      pressed && s.btnPressed,
                    ]}
                  >
                    <Feather
                      name={screenState === "recording" ? "square" : "mic"}
                      size={32}
                      color="#FFFFFF"
                    />
                  </Pressable>
                </View>

                {/* Main Action CTA Button */}
                <Pressable
                  onPress={screenState === "recording" ? handleStopRecording : handleStartRecording}
                  style={({ pressed }) => [
                    s.recActionBtn,
                    screenState === "recording" ? s.recActionStop : s.recActionStart,
                    pressed && s.btnPressed,
                  ]}
                >
                  <Feather
                    name={screenState === "recording" ? "stop-circle" : "radio"}
                    size={16}
                    color="#FFFFFF"
                    style={{ marginRight: 6 }}
                  />
                  <Text style={s.recActionText}>
                    {screenState === "recording" ? "Dừng ghi & Xử lý biên bản" : "Bắt đầu thu âm"}
                  </Text>
                </Pressable>

                {/* Divider */}
                <View style={s.dividerRow}>
                  <View style={s.dividerLine} />
                  <Text style={s.dividerText}>HOẶC TẢI TỆP</Text>
                  <View style={s.dividerLine} />
                </View>

                {/* Upload Audio File */}
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
                    <Feather name="upload" size={16} color="#2563EB" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.uploadTitle}>Tải lên tệp ghi âm</Text>
                    <Text style={s.uploadSub}>MP3, WAV, M4A, WebM (tối đa 200MB / 60+ phút)</Text>
                  </View>
                  <Feather name="chevron-right" size={15} color="#64748B" />
                </Pressable>

                {/* Selected File Info */}
                {selectedFileName ? (
                  <View style={s.selectedFileBox}>
                    <Feather name="file" size={13} color="#2563EB" />
                    <Text style={s.selectedFileName} numberOfLines={1}>{selectedFileName}</Text>
                    <Text style={s.selectedFileSize}>{selectedFileSize}</Text>
                  </View>
                ) : null}

                {/* Ghi chú trọng tâm của Thư ký (Granola-Style Hybrid Notes) */}
                <View style={{
                  width: "100%",
                  marginTop: 12,
                  marginBottom: 4,
                  borderTopWidth: 1,
                  borderTopColor: "#262932",
                  paddingTop: 12,
                }}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Feather name="edit-2" size={12} color="#94A3B8" />
                      <Text style={{ color: "#CBD5E1", fontSize: 11, fontWeight: "600" }}>Ghi chú trọng tâm</Text>
                    </View>
                    <Text style={{ color: "#64748B", fontSize: 10 }}>Tùy chọn</Text>
                  </View>
                  <TextInput
                    value={secretaryNotes}
                    onChangeText={setSecretaryNotes}
                    multiline
                    numberOfLines={3}
                    placeholder="Gõ nhanh ý chính cần AI ưu tiên: chỉ đạo then chốt, mốc hạn quan trọng, phân công nhân sự..."
                    placeholderTextColor="#475569"
                    style={{
                      backgroundColor: "#111318",
                      borderWidth: 1,
                      borderColor: "#262932",
                      borderRadius: 6,
                      padding: 8,
                      color: "#CBD5E1",
                      fontSize: 12,
                      lineHeight: 18,
                      minHeight: 68,
                      textAlignVertical: "top",
                    }}
                  />
                  {secretaryNotes.trim().length > 0 && (
                    <Text style={{ color: "#64748B", fontSize: 10, marginTop: 4 }}>
                      AI sẽ kết hợp ghi chú này với âm thanh để làm nổi bật kết luận.
                    </Text>
                  )}
                </View>

                {/* Specifications List */}
                <View style={s.specBox}>
                  <View style={s.specItem}>
                    <Feather name="shield" size={13} color="#10B981" />
                    <Text style={s.specItemText}>Bảo mật dữ liệu nội bộ 100%</Text>
                  </View>
                  <View style={s.specItem}>
                    <Feather name="zap" size={13} color="#2563EB" />
                    <Text style={s.specItemText}>Gemini File API + Whisper int8</Text>
                  </View>
                  <View style={s.specItem}>
                    <Feather name="file-text" size={13} color="#94A3B8" />
                    <Text style={s.specItemText}>Thể thức Nghị định 30/2020/NĐ-CP</Text>
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
                    <Feather name="file-text" size={28} color="#2563EB" />
                  </View>
                  <Text style={s.idleTitle}>Trung tâm Xử lý & Lập Biên bản</Text>
                  <Text style={s.idleSub}>
                    Sau khi kết thúc ghi âm hoặc tải tệp âm thanh, hệ thống sẽ tự động bóc băng tiếng Việt, tóm tắt nội dung cuộc họp và lập bảng phân công nhiệm vụ theo chuẩn thể thức hành chính.
                  </Text>

                  <View style={s.capList}>
                    <View style={s.capItem}>
                      <View style={s.capBullet}>
                        <Feather name="mic" size={16} color="#2563EB" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.capHead}>Bóc băng giọng nói tiếng Việt độ chính xác cao</Text>
                        <Text style={s.capBody}>Kết hợp Gemini Multimodal Audio và faster-whisper tối ưu hóa giọng nói đa vùng miền.</Text>
                      </View>
                    </View>

                    <View style={s.capItem}>
                      <View style={s.capBullet}>
                        <Feather name="file-text" size={16} color="#10B981" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.capHead}>Biên bản chuẩn thể thức hành chính</Text>
                        <Text style={s.capBody}>Soạn thảo tự động đầy đủ thông tin chung, diễn biến cuộc họp và phần ký duyệt.</Text>
                      </View>
                    </View>

                    <View style={s.capItem}>
                      <View style={s.capBullet}>
                        <Feather name="check-square" size={16} color="#F59E0B" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.capHead}>Bảng phân công nhiệm vụ chi tiết</Text>
                        <Text style={s.capBody}>Trích xuất đầu việc cụ thể, đơn vị/cá nhân phụ trách và thời hạn hoàn thành.</Text>
                      </View>
                    </View>
                  </View>
                </View>
              )}

              {/* TRẠNG THÁI: RECORDING */}
              {screenState === "recording" && (
                <View style={s.recFeedbackCard}>
                  <View style={s.waveContainer}>
                    {[...Array(14)].map((_, i) => (
                      <WaveBar key={i} index={i} />
                    ))}
                  </View>
                  <Text style={s.recFeedTitle}>Đang ghi âm cuộc họp...</Text>
                  <Text style={s.recFeedSub}>
                    Giữ thiết bị gần người phát biểu. Sau khi kết thúc nội dung cuộc họp, nhấn nút "Dừng ghi & Xử lý biên bản".
                  </Text>
                </View>
              )}

              {/* TRẠNG THÁI: PROCESSING VỚI TECHNICAL STEPPER */}
              {screenState === "processing" && (
                <LiveProcessingView progressData={progressData} />
              )}

              {/* TRẠNG THÁI: ERROR */}
              {screenState === "error" && (
                <View style={s.errorCard}>
                  <View style={s.errorIconBox}>
                    <Feather name="alert-triangle" size={28} color="#EF4444" />
                  </View>
                  <Text style={s.errorTitle}>Xử lý không thành công</Text>
                  <Text style={s.errorMsg}>{errorMessage}</Text>
                  {errorDetail ? (
                    <Text style={s.errorDtl}>{errorDetail}</Text>
                  ) : null}
                  <Pressable
                    onPress={handleReset}
                    style={({ pressed }) => [s.retryBtn, pressed && s.btnPressed]}
                  >
                    <Feather name="rotate-cw" size={14} color="#FFFFFF" style={{ marginRight: 6 }} />
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
                  localAudioUrl={localAudioUrl}
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

        <AIConfigModal
          visible={aiConfigModalVisible}
          onClose={() => setAiConfigModalVisible(false)}
        />

      </View>
    </SafeAreaView>
  );
}

// ===========================================================================
// SUB-COMPONENT: StudioAudioPlayer
// ===========================================================================
interface StudioAudioPlayerProps {
  audioUrl: string;
  seekToRef?: React.MutableRefObject<((seconds: number) => void) | null>;
}

function StudioAudioPlayer({ audioUrl, seekToRef }: StudioAudioPlayerProps): React.JSX.Element | null {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web" || !audioUrl) return;
    const audio = new window.Audio(audioUrl);
    audioRef.current = audio;
    audio.playbackRate = playbackRate;

    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => setDuration(audio.duration || 0);
    const onEnd = () => setIsPlaying(false);
    const onErr = () => setIsPlaying(false);

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended", onEnd);
    audio.addEventListener("error", onErr);

    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("ended", onEnd);
      audio.removeEventListener("error", onErr);
      audioRef.current = null;
    };
  }, [audioUrl]);

  useEffect(() => {
    if (seekToRef) {
      seekToRef.current = (seconds: number) => {
        if (audioRef.current) {
          const dur = audioRef.current.duration || duration || seconds;
          audioRef.current.currentTime = Math.max(0, Math.min(seconds, dur));
          audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
        }
      };
    }
  }, [seekToRef, duration]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  };

  const seekRelative = (delta: number) => {
    if (!audioRef.current) return;
    const dur = audioRef.current.duration || duration || 0;
    const target = Math.max(0, Math.min(dur, (audioRef.current.currentTime || 0) + delta));
    audioRef.current.currentTime = target;
    setCurrentTime(target);
  };

  const handleSeek = (e: any) => {
    if (!audioRef.current || !duration) return;
    try {
      const rect = e.currentTarget.getBoundingClientRect();
      const clientX = e.clientX ?? (e.nativeEvent as any)?.clientX ?? 0;
      const x = clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      const targetTime = ratio * duration;
      audioRef.current.currentTime = targetTime;
      setCurrentTime(targetTime);
    } catch {}
  };

  const cycleRate = () => {
    const rates = [1.0, 1.25, 1.5, 2.0];
    const nextRate = rates[(rates.indexOf(playbackRate) + 1) % rates.length];
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  };

  const fmt = (s: number) => {
    if (!s || isNaN(s)) return "00:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  if (Platform.OS !== "web" || !audioUrl) return null;

  const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;

  return (
    <View style={playerStyles.container}>
      {/* Header Info Row */}
      <View style={playerStyles.headerRow}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Feather name="volume-2" size={13} color="#38BDF8" />
          <Text style={playerStyles.title}>Trình phát âm thanh gốc (Studio Audio Player)</Text>
          <View style={playerStyles.engineBadge}>
            <Text style={playerStyles.engineBadgeText}>HTTP 206 STREAM</Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={playerStyles.timeText}>
            {fmt(currentTime)} / {fmt(duration)}
          </Text>
          <Pressable
            onPress={cycleRate}
            style={({ pressed }) => [playerStyles.rateBtn, pressed && { opacity: 0.8 }]}
          >
            <Text style={playerStyles.rateText}>{playbackRate.toFixed(2).replace(".00", ".0")}x</Text>
          </Pressable>
        </View>
      </View>

      {/* Main Scrubber Slider */}
      <View style={playerStyles.scrubberContainer}>
        {Platform.OS === "web" ? (
          React.createElement("input", {
            type: "range",
            min: 0,
            max: duration > 0 ? duration : 100,
            step: 0.1,
            value: currentTime,
            onChange: (e: any) => {
              const target = parseFloat(e.target.value);
              setCurrentTime(target);
              if (audioRef.current) {
                audioRef.current.currentTime = target;
              }
            },
            style: {
              width: "100%",
              height: "6px",
              cursor: "pointer",
              accentColor: "#2563EB",
              backgroundColor: "#0C0E12",
              borderRadius: "3px",
              outline: "none",
              margin: "2px 0",
            },
          })
        ) : (
          <Pressable style={playerStyles.progressTrack} onPress={handleSeek}>
            <View style={playerStyles.progressBg}>
              <View style={[playerStyles.progressFill, { width: `${(progress * 100).toFixed(2)}%` as any }]} />
              <View style={[playerStyles.progressThumb, { left: `${(progress * 100).toFixed(2)}%` as any }]} />
            </View>
          </Pressable>
        )}
      </View>

      {/* Control Buttons Row */}
      <View style={playerStyles.controlsRow}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {/* Tua lùi 10s */}
          <Pressable
            onPress={() => seekRelative(-10)}
            style={({ pressed }) => [playerStyles.skipBtn, pressed && { opacity: 0.7 }]}
            accessibilityLabel="Tua lùi 10 giây"
          >
            <Feather name="rotate-ccw" size={13} color="#94A3B8" />
            <Text style={playerStyles.skipText}>-10s</Text>
          </Pressable>

          {/* Play / Pause */}
          <Pressable
            onPress={togglePlay}
            style={({ pressed }) => [playerStyles.playBtn, pressed && { opacity: 0.8 }]}
            accessibilityLabel={isPlaying ? "Tạm dừng" : "Phát"}
          >
            <Feather name={isPlaying ? "pause" : "play"} size={16} color="#FFFFFF" />
          </Pressable>

          {/* Tua tới 10s */}
          <Pressable
            onPress={() => seekRelative(10)}
            style={({ pressed }) => [playerStyles.skipBtn, pressed && { opacity: 0.7 }]}
            accessibilityLabel="Tua tới 10 giây"
          >
            <Feather name="rotate-cw" size={13} color="#94A3B8" />
            <Text style={playerStyles.skipText}>+10s</Text>
          </Pressable>
        </View>

        <Text style={playerStyles.hintText}>Click mốc thời gian [MM:SS] trong bản gỡ băng để tua nhanh</Text>
      </View>
    </View>
  );
}

const playerStyles = StyleSheet.create({
  container: {
    backgroundColor: "#161920",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#262932",
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 12,
    gap: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    color: "#E2E8F0",
    fontSize: 12,
    fontWeight: "600",
  },
  engineBadge: {
    backgroundColor: "rgba(56, 189, 248, 0.12)",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(56, 189, 248, 0.25)",
  },
  engineBadgeText: {
    color: "#38BDF8",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  timeText: {
    color: "#94A3B8",
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    fontWeight: "600",
  },
  scrubberContainer: {
    width: "100%",
  },
  progressTrack: {
    height: 16,
    justifyContent: "center",
  },
  progressBg: {
    height: 5,
    backgroundColor: "#0C0E12",
    borderRadius: 3,
    position: "relative",
    overflow: "visible",
  },
  progressFill: {
    height: 5,
    backgroundColor: "#2563EB",
    borderRadius: 3,
  },
  progressThumb: {
    position: "absolute",
    top: -3.5,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#60A5FA",
    marginLeft: -6,
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  playBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#2563EB",
    alignItems: "center",
    justifyContent: "center",
  },
  skipBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#111318",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#262932",
  },
  skipText: {
    color: "#CBD5E1",
    fontSize: 11,
    fontWeight: "600",
  },
  hintText: {
    color: "#64748B",
    fontSize: 11,
    fontStyle: "italic",
  },
  rateBtn: {
    backgroundColor: "#111318",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: "#262932",
  },
  rateText: {
    color: "#60A5FA",
    fontSize: 11,
    fontWeight: "700",
  },
});

// ===========================================================================
// SUB-COMPONENT: WaveBar (Waveform animation bar)
// ===========================================================================
function WaveBar({ index }: { index: number }): React.JSX.Element {
  const anim = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const delay = index * 70;
    const duration = 400 + Math.random() * 350;
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
      width: 3,
      height: 32,
      borderRadius: 2,
      backgroundColor: "#EF4444",
      marginHorizontal: 2.5,
      transform: [{ scaleY: anim }],
    }} />
  );
}

// ===========================================================================
// SUB-COMPONENT: LiveProcessingView (Technical Stepper)
// ===========================================================================
function LiveProcessingView({ progressData }: { progressData: ProgressData | null }): React.JSX.Element {
  const percent = progressData?.progress_percent ?? 0;
  const stepDetail = progressData?.current_step_detail ?? "Đang thiết lập kết nối với AI engine...";
  const partialTranscript = progressData?.partial_transcript ?? "";
  const status = progressData?.status ?? "uploading";

  const isTranscribing = status === "transcribing" || (percent >= 5 && percent < 60);
  const isSummarizing = status === "summarizing" || (percent >= 60 && percent < 100);
  const isCompleted = status === "completed";

  return (
    <View style={procStyles.container}>
      <View style={procStyles.metricRow}>
        <View style={procStyles.headerLeft}>
          <Text style={procStyles.title}>Tiến trình Xử lý AI</Text>
          <Text style={procStyles.detail}>{stepDetail}</Text>
        </View>
        <Text style={procStyles.percentText}>{percent}%</Text>
      </View>

      {/* Thin Technical Progress Bar */}
      <View style={procStyles.progressBarBg}>
        <View style={[procStyles.progressBarFill, { width: `${Math.min(percent, 100)}%` }]} />
      </View>

      {/* Stepper list */}
      <View style={procStyles.stepList}>
        <View style={[procStyles.stepItem, isTranscribing && procStyles.stepItemActive]}>
          <View style={[
            procStyles.stepCircle,
            (isTranscribing || isSummarizing || isCompleted) && procStyles.stepCircleActive,
            (isSummarizing || isCompleted) && procStyles.stepCircleDone,
          ]}>
            {isSummarizing || isCompleted ? (
              <Feather name="check" size={13} color="#FFFFFF" />
            ) : isTranscribing ? (
              <ActivityIndicator size="small" color="#2563EB" />
            ) : (
              <Text style={procStyles.stepNum}>1</Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={procStyles.stepTitle}>Bóc băng âm thanh (STT Engine)</Text>
            <Text style={procStyles.stepSub}>Nhận diện giọng nói với bộ lọc âm thanh VAD</Text>
          </View>
        </View>

        <View style={[procStyles.stepItem, isSummarizing && procStyles.stepItemActive]}>
          <View style={[
            procStyles.stepCircle,
            (isSummarizing || isCompleted) && procStyles.stepCircleActive,
            isCompleted && procStyles.stepCircleDone,
          ]}>
            {isCompleted ? (
              <Feather name="check" size={13} color="#FFFFFF" />
            ) : isSummarizing ? (
              <ActivityIndicator size="small" color="#2563EB" />
            ) : (
              <Text style={procStyles.stepNum}>2</Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={procStyles.stepTitle}>Cấu trúc hóa Biên bản & Phân công nhiệm vụ</Text>
            <Text style={procStyles.stepSub}>Tổng hợp nội dung theo thể thức Nghị định 30/2020/NĐ-CP</Text>
          </View>
        </View>
      </View>

      {/* Live Transcript Preview */}
      {partialTranscript ? (
        <View style={procStyles.liveTranscriptBox}>
          <View style={procStyles.liveTranscriptHeader}>
            <Feather name="file-text" size={13} color="#2563EB" />
            <Text style={procStyles.liveTranscriptTitle}>Văn bản bóc băng thời gian thực</Text>
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
  localAudioUrl?: string;
  activeTab: "minutes" | "tasks" | "transcript" | "copilot";
  onTabChange: (tab: "minutes" | "tasks" | "transcript" | "copilot") => void;
  fadeAnim: Animated.Value;
  slideAnim: Animated.Value;
  onRecordNew: () => void;
}

function ResultDashboard({
  meetingId,
  meetingTitle,
  result,
  localAudioUrl = "",
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

  // Grounded Meeting Copilot Q&A States (NotebookLM Pattern)
  const [copilotQuestion, setCopilotQuestion] = useState("");
  const [copilotLoading, setCopilotLoading] = useState(false);
  const [copilotAnswer, setCopilotAnswer] = useState<string | null>(null);
  const [copilotEngine, setCopilotEngine] = useState<string | null>(null);
  const [copilotCopied, setCopilotCopied] = useState(false);

  // Chế độ loại văn bản hành chính: "minutes" (Biên bản cuộc họp) | "notice" (Thông báo kết luận)
  const [docMode, setDocMode] = useState<"minutes" | "notice">("minutes");

  // Audio Player Seek Reference & Audio URL
  const seekToRef = useRef<((seconds: number) => void) | null>(null);
  const audioUrl = useMemo(() => {
    // 1. Ưu tiên URL cục bộ (0 độ trễ khi vừa chọn file hoặc vừa ghi âm)
    if (localAudioUrl) return localAudioUrl;
    // 2. Stream qua endpoint HTTP 206 Partial Content của Backend
    if (result?.audio_file_url) {
      if (result.audio_file_url.startsWith("http://") || result.audio_file_url.startsWith("https://")) {
        return result.audio_file_url;
      }
      return `${BASE_URL}/api/v1/audio/${meetingId}/stream`;
    }
    return "";
  }, [localAudioUrl, result?.audio_file_url, meetingId]);

  // Task Sheet Copy State
  const [copiedTaskSheet, setCopiedTaskSheet] = useState(false);

  const COPILOT_QUICK_PROMPTS = [
    "Tóm tắt 3 kết luận quan trọng nhất của cuộc họp?",
    "Ai được giao những việc gì và hạn chót khi nào?",
    "Có nội dung nào bất đồng ý kiến hoặc cần xin ý kiến cấp trên?",
  ];

  const handleAskCopilot = async (customQ?: string) => {
    const query = (customQ || copilotQuestion).trim();
    if (!query || copilotLoading) return;
    setCopilotLoading(true);
    try {
      const res = await axios.post<{ answer: string; engine: string }>(
        API_ENDPOINTS.askMeeting(meetingId),
        { question: query },
        { headers: { "Content-Type": "application/json" }, timeout: 60000 }
      );
      setCopilotAnswer(res.data.answer);
      setCopilotEngine(res.data.engine);
      if (!customQ) setCopilotQuestion("");
    } catch (err: any) {
      const msg = err.response?.data?.detail?.message || "Không thể lấy câu trả lời từ trợ lý AI.";
      Alert.alert("Lỗi Trợ lý AI", typeof msg === "string" ? msg : JSON.stringify(msg));
    } finally {
      setCopilotLoading(false);
    }
  };

  const handleCopyCopilotAnswer = async (text: string) => {
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(text);
        setCopilotCopied(true);
        setTimeout(() => setCopilotCopied(false), 2000);
      } catch {}
    } else {
      Clipboard.setString(text);
      setCopilotCopied(true);
      setTimeout(() => setCopilotCopied(false), 2000);
    }
  };

  // Template Data State
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
  const [docSecretary, setDocSecretary] = useState("Bộ phận Thư ký ghi chép");
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

  useEffect(() => {
    if (result.minutes) {
      setMinutesContent(result.minutes);
    }
  }, [result.minutes]);

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
      };
    }
    if (paperTheme === "dark") {
      return {
        bg: "#111318",
        text: "#F8FAFC",
        textMuted: "#94A3B8",
        border: "#262932",
        headBorder: "#262932",
        tableHeaderBg: "#161920",
        tableRowEven: "#1A1D26",
        tableBorder: "#262932",
        inputBg: "#161920",
        editorBg: "#0C0E12",
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
      Alert.alert("Lỗi", "Không thể lưu biên bản lên máy chủ. Vui lòng thử lại.");
    } finally {
      setIsSaving(false);
    }
  };

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
      Alert.alert("Lỗi", "Không thể lưu bản gỡ băng lên máy chủ.");
    } finally {
      setIsSavingTranscript(false);
    }
  };

  const insertFormatting = (prefix: string, suffix: string = "") => {
    setMinutesContent((prev) => {
      const needsNewline = prev.length > 0 && !prev.endsWith("\n");
      return prev + (needsNewline ? "\n" : "") + prefix + suffix;
    });
  };

  const handleResetMinutes = () => {
    if (Platform.OS === "web") {
      if (window.confirm("Khôi phục lại nội dung biên bản ban đầu từ AI? Mọi chỉnh sửa thủ công sẽ được hoàn tác.")) {
        setMinutesContent(result.minutes || "");
      }
    } else {
      Alert.alert(
        "Khôi phục bản gốc",
        "Bạn có chắc muốn hoàn tác các chỉnh sửa về văn bản AI ban đầu?",
        [
          { text: "Hủy", style: "cancel" },
          { text: "Khôi phục", style: "destructive", onPress: () => setMinutesContent(result.minutes || "") },
        ]
      );
    }
  };

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
      Alert.alert("Thông báo", "Biên bản và bảng phân công nhiệm vụ đã được tái cấu trúc thành công.");
    } catch (err: any) {
      const msg = err.response?.data?.detail || "Không thể thực hiện tái cấu trúc AI. Vui lòng kiểm tra lại.";
      Alert.alert("Lỗi AI Studio", typeof msg === "string" ? msg : JSON.stringify(msg));
    } finally {
      setAiRewriteLoading(false);
      setAiActiveMode(null);
    }
  };

  // Xuất file Word (.doc)
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
          <td align="center" style="border: 1px solid #000; padding: 6px 8px; font-size: ${tableFontSizePt};">${t.due_date || "Theo kế hoạch"}</td>
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

  <table class="header-table">
    <tr>
      <td style="width: 45%;">
        <div class="org-name">VIETMEETING AI WORKSPACE</div>
        <div class="doc-no">Số: ${String(meetingId).padStart(4, "0")}/${docMode === "notice" ? "TB-CH" : "BB-CH"}</div>
      </td>
      <td style="width: 55%;">
        <div class="nation-name">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
        <div class="motto">Độc lập - Tự do - Hạnh phúc</div>
        <div class="motto-line">-------------------</div>
      </td>
    </tr>
  </table>

  <div class="date-line">Hà Nội, ${docDate}</div>

  <div class="title-main">${docMode === "notice" ? "THÔNG BÁO" : "BIÊN BẢN CUỘC HỌP"}</div>
  <div class="title-sub">${docMode === "notice" ? `Kết luận của ${docChair} tại cuộc họp "${docTitle}"` : docTitle}</div>

  <div class="section-head">I. THÔNG TIN CHUNG</div>
  <p style="text-indent: 1.25cm; margin: 4px 0;"><b>1. Thời gian:</b> ${docTime}.</p>
  <p style="text-indent: 1.25cm; margin: 4px 0;"><b>2. Địa điểm / Hình thức:</b> ${docLocation}.</p>
  <p style="text-indent: 1.25cm; margin: 4px 0;"><b>3. Chủ trì cuộc họp:</b> ${docChair}.</p>
  ${docMode === "minutes" ? `<p style="text-indent: 1.25cm; margin: 4px 0;"><b>4. Thư ký ghi biên bản:</b> ${docSecretary}.</p>` : ""}
  <p style="text-indent: 1.25cm; margin: 4px 0;"><b>${docMode === "minutes" ? "5" : "4"}. Thành phần tham dự:</b> ${docAttendees}.</p>
  ${docMode === "notice" ? `<p style="text-indent: 1.25cm; margin: 8px 0;">Sau khi nghe báo cáo và các ý kiến phát biểu tại cuộc họp, đồng chí <b>${docChair}</b> đã kết luận và chỉ đạo các nội dung trọng tâm như sau:</p>` : ""}

  <div class="section-head">${docMode === "notice" ? "II. NỘI DUNG KẾT LUẬN VÀ CHỈ ĐẠO" : "II. NỘI DUNG DIỄN BIẾN CUỘC HỌP"}</div>
  ${minutesParagraphs}

  <div class="section-head">${docMode === "notice" ? "III. PHÂN CÔNG TỔ CHỨC THỰC HIỆN" : "III. BẢNG PHÂN CÔNG NHIỆM VỤ / KẾT LUẬN CHỈ ĐẠO"}</div>
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

  <table class="sig-table">
    <tr>
      ${docMode === "notice" ? `
      <td style="text-align: left; vertical-align: top; padding-left: 15px;">
        <div class="sig-note"><b><i>Nơi nhận:</i></b></div>
        <div class="sig-note">- Như thành phần tham dự;</div>
        <div class="sig-note">- Lãnh đạo cơ quan;</div>
        <div class="sig-note">- Lưu: VT, TH.</div>
      </td>
      <td>
        <div class="sig-role">NGƯỜI CHỦ TRÌ</div>
        <div class="sig-note">(Ký và ghi rõ họ tên)</div>
        <div class="sig-space"></div>
        <div><i>(Đã duyệt & ký)</i></div>
        <div style="font-weight: bold; margin-top: 4px;">${docChair}</div>
      </td>
      ` : `
      <td>
        <div class="sig-role">THƯ KÝ GHI BIÊN BẢN</div>
        <div class="sig-note">(Ký và ghi rõ họ tên)</div>
        <div class="sig-space"></div>
        <div><i>(Đã ký xác nhận)</i></div>
      </td>
      <td>
        <div class="sig-role">CHỦ TRÌ CUỘC HỌP</div>
        <div class="sig-note">(Ký và ghi rõ họ tên)</div>
        <div class="sig-space"></div>
        <div><i>(Đã duyệt & ký)</i></div>
      </td>
      `}
    </tr>
  </table>

</body>
</html>`;
  };

  const handleDownloadWord = () => {
    const htmlContent = generateWordHtml();
    const safeTitle = docTitle.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_").slice(0, 30) || String(meetingId);
    const fileName = docMode === "notice" ? `Thong_Bao_Ket_Luan_${safeTitle}.doc` : `Bien_Ban_Cuoc_Hop_${safeTitle}.doc`;
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

  // Typography & Document Ribbon Toolbar
  const renderTypographyToolbar = () => (
    <View style={resStyles.ribbonToolbar}>
      {/* Hàng 1: Phông chữ & Nền giấy */}
      <View style={resStyles.ribbonRow}>
        <View style={resStyles.ribbonGroup}>
          <Text style={resStyles.ribbonLabel}>Phông chữ</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }}>
            {(
              [
                { id: "Times New Roman" as const, name: "Times New Roman" },
                { id: "Arial" as const, name: "Arial" },
                { id: "Roboto" as const, name: "Roboto" },
                { id: "Georgia" as const, name: "Georgia" },
                { id: "Tahoma" as const, name: "Tahoma" },
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
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        <View style={resStyles.ribbonGroup}>
          <Text style={resStyles.ribbonLabel}>Nền giấy</Text>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {(
              [
                { id: "white" as const, label: "Trắng A4", icon: "file" as const },
                { id: "sepia" as const, label: "Giấy ngà", icon: "book-open" as const },
                { id: "dark" as const, label: "Tối Studio", icon: "moon" as const },
              ] as const
            ).map((theme) => {
              const isSelected = paperTheme === theme.id;
              return (
                <Pressable
                  key={theme.id}
                  onPress={() => setPaperTheme(theme.id)}
                  style={[resStyles.themePill, isSelected && resStyles.themePillActive]}
                >
                  <Feather
                    name={theme.icon}
                    size={11}
                    color={isSelected ? "#2563EB" : "#64748B"}
                    style={{ marginRight: 4 }}
                  />
                  <Text style={[resStyles.themePillText, isSelected && resStyles.themePillTextActive]}>
                    {theme.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>

      {/* Hàng 2: Cỡ chữ, Giãn dòng, Căn lề */}
      <View style={[resStyles.ribbonRow, { borderTopWidth: 1, borderTopColor: "#262932", paddingTop: 8 }]}>
        <View style={resStyles.ribbonGroup}>
          <Text style={resStyles.ribbonLabel}>Cỡ chữ</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            <Pressable
              onPress={() => setFontSize((prev) => Math.max(11, prev - 1))}
              style={({ pressed }) => [resStyles.sizeStepperBtn, pressed && resStyles.btnPressed]}
            >
              <Text style={resStyles.sizeStepperText}>-</Text>
            </Pressable>
            {[11, 12, 13, 14, 16].map((s) => {
              const isSelected = fontSize === s;
              return (
                <Pressable
                  key={s}
                  onPress={() => setFontSize(s)}
                  style={[resStyles.sizePill, isSelected && resStyles.sizePillActive]}
                >
                  <Text style={[resStyles.sizePillText, isSelected && resStyles.sizePillTextActive]}>
                    {s}pt
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => setFontSize((prev) => Math.min(16, prev + 1))}
              style={({ pressed }) => [resStyles.sizeStepperBtn, pressed && resStyles.btnPressed]}
            >
              <Text style={resStyles.sizeStepperText}>+</Text>
            </Pressable>
          </View>
        </View>

        <View style={resStyles.ribbonGroup}>
          <Text style={resStyles.ribbonLabel}>Giãn dòng</Text>
          <View style={{ flexDirection: "row", gap: 3 }}>
            {[
              { val: 1.15, label: "1.15" },
              { val: 1.3, label: "1.30 (Chuẩn)" },
              { val: 1.5, label: "1.50" },
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

        <View style={resStyles.ribbonGroup}>
          <Text style={resStyles.ribbonLabel}>Căn lề</Text>
          <View style={{ flexDirection: "row", gap: 3 }}>
            {[
              { id: "justify" as const, icon: "align-justify" as const, label: "Đều" },
              { id: "left" as const, icon: "align-left" as const, label: "Trái" },
              { id: "center" as const, icon: "align-center" as const, label: "Giữa" },
            ].map((align) => {
              const isSelected = textAlign === align.id;
              return (
                <Pressable
                  key={align.id}
                  onPress={() => setTextAlign(align.id)}
                  style={[resStyles.alignBtn, isSelected && resStyles.alignBtnActive]}
                >
                  <Feather
                    name={align.icon}
                    size={13}
                    color={isSelected ? "#2563EB" : "#94A3B8"}
                  />
                  <Text style={[resStyles.alignBtnText, isSelected && { color: "#2563EB" }]}>
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

  // Component AI Style Switcher (Segmented Control phong cách Linear)
  const renderAITextStudio = () => (
    <View style={resStyles.aiStudioCard}>
      <View style={resStyles.aiStudioHeader}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={resStyles.aiStudioIconBox}>
            <Feather name="sliders" size={14} color="#2563EB" />
          </View>
          <View>
            <Text style={resStyles.aiStudioTitle}>Phong cách Văn bản AI (Gemini Engine)</Text>
            <Text style={resStyles.aiStudioSub}>
              Tái cấu trúc biên bản theo văn phong hành chính nhà nước hoặc doanh nghiệp
            </Text>
          </View>
        </View>
        {aiRewriteLoading ? (
          <View style={resStyles.aiLoadingBadge}>
            <ActivityIndicator size="small" color="#2563EB" />
            <Text style={resStyles.aiLoadingText}>Đang biên tập lại...</Text>
          </View>
        ) : null}
      </View>

      {/* Preset Pill Tabs */}
      <View style={resStyles.aiPresetsRow}>
        {(
          [
            { mode: "administrative" as const, label: "Hành chính (NĐ 30)", icon: "file-text" as const, desc: "Thể thức chuẩn" },
            { mode: "corporate" as const, label: "Doanh nghiệp", icon: "briefcase" as const, desc: "KPI & Quyết định" },
            { mode: "news_digest" as const, label: "Bản tin sự kiện", icon: "calendar" as const, desc: "Tóm tắt diễn biến" },
            { mode: "concise" as const, label: "Tóm tắt 1 trang", icon: "minimize-2" as const, desc: "Báo cáo điều hành" },
            { mode: "detailed" as const, label: "Bản chi tiết", icon: "maximize-2" as const, desc: "Mở rộng số liệu" },
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
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Feather name={preset.icon} size={12} color={isActive ? "#2563EB" : "#94A3B8"} />
                <Text style={[resStyles.aiPresetLabel, isActive && { color: "#2563EB" }]}>{preset.label}</Text>
              </View>
              <Text style={resStyles.aiPresetDesc}>{preset.desc}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Custom Prompt Input */}
      <View style={resStyles.aiPromptBar}>
        <TextInput
          value={aiPromptInput}
          onChangeText={setAiPromptInput}
          placeholder="Nhập yêu cầu tùy chỉnh cho AI (VD: Làm rõ các số liệu ngân sách, tổng hợp quyết định quan trọng...)"
          placeholderTextColor="#64748B"
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
          <Feather name="send" size={13} color="#FFFFFF" style={{ marginRight: 5 }} />
          <Text style={resStyles.aiPromptSubmitText}>Thực hiện</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <Animated.View style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>

      {/* Top Completion Summary Banner */}
      <View style={resStyles.topBanner}>
        <View style={resStyles.topBannerLeft}>
          <View style={resStyles.successCircle}>
            <Feather name="check" size={18} color="#10B981" />
          </View>
          <View>
            <Text style={resStyles.topBannerTitle}>Xử lý thành công</Text>
            <Text style={resStyles.topBannerSub}>
              Hệ thống đã trích xuất {tasks.length} nhiệm vụ và định dạng biên bản hoàn tất
            </Text>
          </View>
        </View>

        <Pressable
          onPress={onRecordNew}
          style={({ pressed }) => [resStyles.newRecBtn, pressed && resStyles.btnPressed]}
        >
          <Feather name="rotate-cw" size={13} color="#2563EB" style={{ marginRight: 5 }} />
          <Text style={resStyles.newRecBtnText}>Phiên ghi mới</Text>
        </Pressable>
      </View>

      {/* Tabs Switcher */}
      <View style={resStyles.tabsRow}>
        {[
          { id: "minutes" as const, label: "Biên bản cuộc họp", icon: "file-text" as const },
          { id: "tasks" as const, label: `Bảng phân công nhiệm vụ (${completedTasksCount}/${tasks.length})`, icon: "check-square" as const },
          { id: "transcript" as const, label: "Bản gỡ băng gốc", icon: "mic" as const },
          { id: "copilot" as const, label: "Hỏi đáp AI", icon: "message-square" as const },
        ].map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <Pressable
              key={tab.id}
              onPress={() => onTabChange(tab.id)}
              style={[resStyles.tabBtn, isActive && resStyles.tabBtnActive]}
            >
              <Feather
                name={tab.icon}
                size={14}
                color={isActive ? "#2563EB" : "#94A3B8"}
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
          TAB 1: BIÊN BẢN CUỘC HỌP (TRANG GIẤY A4 NGHỊ ĐỊNH 30)
      ===================================================================== */}
      {activeTab === "minutes" && (
        <View style={{ gap: 12 }}>

          {/* Studio Audio Player */}
          {audioUrl ? <StudioAudioPlayer audioUrl={audioUrl} seekToRef={seekToRef} /> : null}

          {/* Bộ chuyển đổi loại văn bản hành chính theo Nghị định 30 */}
          <View style={{
            flexDirection: "row",
            backgroundColor: "#161920",
            borderRadius: 8,
            borderWidth: 1,
            borderColor: "#262932",
            padding: 4,
            gap: 6,
          }}>
            {[
              { id: "minutes" as const, label: "Biên bản cuộc họp", sub: "Thể thức chuẩn Nghị định 30", icon: "file-text" as const },
              { id: "notice" as const, label: "Thông báo kết luận", sub: "Chỉ đạo & phân công giao việc", icon: "bell" as const },
            ].map((mode) => {
              const isActive = docMode === mode.id;
              return (
                <Pressable
                  key={mode.id}
                  onPress={() => setDocMode(mode.id)}
                  style={({ pressed }) => [{
                    flex: 1,
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    paddingVertical: 8,
                    paddingHorizontal: 12,
                    borderRadius: 6,
                    backgroundColor: isActive ? "#2563EB" : "transparent",
                    opacity: pressed ? 0.8 : 1,
                  }]}
                >
                  <Feather name={mode.icon} size={14} color={isActive ? "#FFFFFF" : "#64748B"} />
                  <View>
                    <Text style={{ color: isActive ? "#FFFFFF" : "#CBD5E1", fontSize: 12, fontWeight: isActive ? "700" : "500" }}>
                      {mode.label}
                    </Text>
                    <Text style={{ color: isActive ? "rgba(255,255,255,0.8)" : "#64748B", fontSize: 10 }}>
                      {mode.sub}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {/* AI Style Switcher */}
          {renderAITextStudio()}

          {/* Ribbon Toolbar */}
          {renderTypographyToolbar()}

          {/* Action Toolbar */}
          <View style={resStyles.actionToolbarCard}>
            <View style={resStyles.actionToolbarLeft}>
              <Pressable
                onPress={handleDownloadWord}
                style={({ pressed }) => [resStyles.wordDownloadBtn, pressed && resStyles.btnPressed]}
              >
                <Feather name="download" size={15} color="#FFFFFF" style={{ marginRight: 6 }} />
                <Text style={resStyles.wordDownloadBtnText}>Xuất tệp Word (.doc)</Text>
              </Pressable>

              <Pressable
                onPress={handlePrint}
                style={({ pressed }) => [resStyles.toolBtn, pressed && resStyles.btnPressed]}
              >
                <Feather name="printer" size={14} color="#CBD5E1" style={{ marginRight: 5 }} />
                <Text style={resStyles.toolBtnText}>In ấn / PDF</Text>
              </Pressable>
            </View>

            <View style={resStyles.actionToolbarRight}>
              <Pressable
                onPress={() => setIsEditing(!isEditing)}
                style={({ pressed }) => [
                  resStyles.toolBtn,
                  isEditing && resStyles.toolBtnActive,
                  pressed && resStyles.btnPressed,
                ]}
              >
                <Feather
                  name={isEditing ? "eye" : "edit-3"}
                  size={14}
                  color={isEditing ? "#2563EB" : "#CBD5E1"}
                  style={{ marginRight: 5 }}
                />
                <Text style={[resStyles.toolBtnText, isEditing && { color: "#2563EB" }]}>
                  {isEditing ? "Xem mẫu chuẩn" : "Chỉnh sửa biểu mẫu"}
                </Text>
              </Pressable>

              <Pressable
                onPress={handleSaveToDB}
                disabled={isSaving}
                style={({ pressed }) => [resStyles.toolBtn, pressed && resStyles.btnPressed]}
              >
                {isSaving ? (
                  <ActivityIndicator size="small" color="#10B981" />
                ) : (
                  <Feather
                    name={savedToast ? "check" : "save"}
                    size={14}
                    color="#10B981"
                    style={{ marginRight: 5 }}
                  />
                )}
                <Text style={[resStyles.toolBtnText, { color: "#10B981" }]}>
                  {savedToast ? "Đã lưu" : "Lưu thay đổi"}
                </Text>
              </Pressable>

              <Pressable
                onPress={() => handleCopyText(minutesContent)}
                style={({ pressed }) => [resStyles.toolBtn, pressed && resStyles.btnPressed]}
              >
                <Feather
                  name={copied ? "check" : "copy"}
                  size={14}
                  color="#2563EB"
                  style={{ marginRight: 5 }}
                />
                <Text style={resStyles.toolBtnText}>{copied ? "Đã chép" : "Sao chép"}</Text>
              </Pressable>
            </View>
          </View>

          {/* Quick Formatting Bar */}
          {isEditing && (
            <View style={resStyles.quickFormatCard}>
              <View style={resStyles.quickFormatLeft}>
                <Text style={resStyles.quickFormatLabel}>Định dạng nhanh:</Text>
                <Pressable
                  onPress={() => insertFormatting("**", "**")}
                  style={({ pressed }) => [resStyles.qfBtn, pressed && resStyles.btnPressed]}
                >
                  <Text style={[resStyles.qfBtnText, { fontWeight: "700" }]}>B</Text>
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
                  <Text style={resStyles.qfBtnText}>• Danh sách</Text>
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
                  <Text style={resStyles.qfBtnText}>--- Phân đoạn</Text>
                </Pressable>
              </View>

              <Pressable
                onPress={handleResetMinutes}
                style={({ pressed }) => [resStyles.undoResetBtn, pressed && resStyles.btnPressed]}
              >
                <Feather name="rotate-ccw" size={13} color="#EF4444" style={{ marginRight: 4 }} />
                <Text style={resStyles.undoResetText}>Khôi phục bản gốc</Text>
              </Pressable>
            </View>
          )}

          {/* A4 PAPER SHEET CONTAINER */}
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
                  Số: {String(meetingId).padStart(4, "0")}/{docMode === "notice" ? "TB-CH" : "BB-CH"}
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
                    placeholderTextColor="#94A3B8"
                  />
                </View>
              ) : (
                <Text style={[resStyles.paperDateText, { color: themeColors.textMuted, fontFamily }]}>Hà Nội, {docDate}</Text>
              )}
            </View>

            {/* Main Title */}
            <View style={resStyles.paperTitleBox}>
              <Text style={[resStyles.paperMainTitle, { color: themeColors.text, fontFamily }]}>
                {docMode === "notice" ? "THÔNG BÁO" : "BIÊN BẢN CUỘC HỌP"}
              </Text>
              {isEditing ? (
                <TextInput
                  value={docTitle}
                  onChangeText={setDocTitle}
                  style={[
                    resStyles.inlineInput,
                    resStyles.paperSubTitleInput,
                    { backgroundColor: themeColors.inputBg, color: themeColors.text, fontFamily },
                  ]}
                  placeholder="Nhập tiêu đề cuộc họp..."
                  placeholderTextColor="#94A3B8"
                />
              ) : (
                <Text style={[resStyles.paperSubTitle, { color: themeColors.textMuted, fontFamily }]}>
                  {docMode === "notice"
                    ? `Kết luận của ${docChair} tại cuộc họp "${docTitle}"`
                    : `Về việc: ${docTitle}`}
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

              {docMode === "minutes" && (
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
              )}

              <View style={resStyles.infoRow}>
                <Text style={[resStyles.infoLabel, { color: themeColors.text, fontFamily }]}>
                  {docMode === "minutes" ? "5" : "4"}. Thành phần tham dự:
                </Text>
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

              {docMode === "notice" && (
                <Text style={[resStyles.paperNormalText, { color: themeColors.text, fontFamily, fontSize, marginTop: 8, fontStyle: "italic" }]}>
                  Sau khi nghe báo cáo tổng hợp và các ý kiến phát biểu tại cuộc họp, đồng chí <b>{docChair}</b> đã kết luận và chỉ đạo các nội dung trọng tâm như sau:
                </Text>
              )}
            </View>

            {/* MỤC II: NỘI DUNG DIỄN BIẾN CUỘC HỌP */}
            <View style={resStyles.docSection}>
              <Text style={[resStyles.docSectionHead, { color: themeColors.text, borderBottomColor: themeColors.headBorder, fontFamily }]}>
                {docMode === "notice" ? "II. NỘI DUNG KẾT LUẬN VÀ CHỈ ĐẠO" : "II. NỘI DUNG DIỄN BIẾN CUỘC HỌP"}
              </Text>

              {isEditing ? (
                <View style={resStyles.editorBox}>
                  <Text style={[resStyles.editorHint, { color: themeColors.textMuted }]}>
                    Soạn thảo trực tiếp nội dung biên bản dưới đây trước khi bấm "Lưu thay đổi" hoặc "Xuất tệp Word":
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
                {docMode === "notice" ? "III. PHÂN CÔNG TỔ CHỨC THỰC HIỆN" : "III. BẢNG PHÂN CÔNG NHIỆM VỤ / KẾT LUẬN CHỈ ĐẠO"}
              </Text>

              <View style={[resStyles.tableWrapper, { borderColor: themeColors.tableBorder }]}>
                <View style={[resStyles.tableHeaderRow, { backgroundColor: themeColors.tableHeaderBg, borderBottomColor: themeColors.tableBorder }]}>
                  <Text style={[resStyles.thCell, { width: 45, textAlign: "center", color: themeColors.text, borderRightColor: themeColors.tableBorder, fontFamily }]}>STT</Text>
                  <Text style={[resStyles.thCell, { flex: 2, color: themeColors.text, borderRightColor: themeColors.tableBorder, fontFamily }]}>Nội dung nhiệm vụ / Chỉ đạo</Text>
                  <Text style={[resStyles.thCell, { flex: 1.2, textAlign: "center", color: themeColors.text, borderRightColor: themeColors.tableBorder, fontFamily }]}>Đơn vị phụ trách</Text>
                  <Text style={[resStyles.thCell, { width: 105, textAlign: "center", color: themeColors.text, fontFamily }]}>Thời hạn</Text>
                </View>

                {tasks.length === 0 ? (
                  <View style={resStyles.tableEmptyRow}>
                    <Text style={[resStyles.tableEmptyText, { color: themeColors.textMuted, fontFamily }]}>
                      Không phát sinh nhiệm vụ phân công cụ thể trong cuộc họp.
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
                      <Text style={[resStyles.tdCell, { width: 45, textAlign: "center", fontWeight: "600", color: themeColors.text, borderRightColor: themeColors.tableBorder, fontFamily }]}>
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
                      <Text style={[resStyles.tdCell, { width: 105, textAlign: "center", color: themeColors.text, fontFamily }]}>
                        {task.due_date || "Theo kế hoạch"}
                      </Text>
                    </View>
                  ))
                )}
              </View>
            </View>

            {/* Phần Chữ ký */}
            <View style={[resStyles.sigContainer, { borderTopColor: themeColors.border }]}>
              {docMode === "notice" ? (
                <View style={[resStyles.sigCol, { alignItems: "flex-start", paddingLeft: 16 }]}>
                  <Text style={[resStyles.sigNote, { color: themeColors.text, fontFamily, fontWeight: "700" }]}>Nơi nhận:</Text>
                  <Text style={[resStyles.sigNote, { color: themeColors.textMuted, fontFamily, marginTop: 4 }]}>- Như thành phần tham dự;</Text>
                  <Text style={[resStyles.sigNote, { color: themeColors.textMuted, fontFamily }]}>- Lãnh đạo cơ quan;</Text>
                  <Text style={[resStyles.sigNote, { color: themeColors.textMuted, fontFamily }]}>- Lưu: VT, TH.</Text>
                </View>
              ) : (
                <View style={resStyles.sigCol}>
                  <Text style={[resStyles.sigRole, { color: themeColors.text, fontFamily }]}>THƯ KÝ GHI BIÊN BẢN</Text>
                  <Text style={[resStyles.sigNote, { color: themeColors.textMuted, fontFamily }]}>(Ký và ghi rõ họ tên)</Text>
                  <View style={resStyles.sigSpace} />
                  <Text style={[resStyles.sigSigned, { fontFamily }]}><i>(Đã ký xác nhận)</i></Text>
                  <Text style={[resStyles.sigName, { color: themeColors.text, fontFamily }]}>{docSecretary}</Text>
                </View>
              )}

              <View style={resStyles.sigCol}>
                <Text style={[resStyles.sigRole, { color: themeColors.text, fontFamily }]}>
                  {docMode === "notice" ? "NGƯỜI CHỦ TRÌ" : "CHỦ TRÌ CUỘC HỌP"}
                </Text>
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
          TAB 2: BẢNG PHÂN CÔNG NHIỆM VỤ
      ===================================================================== */}
      {activeTab === "tasks" && (
        <View style={resStyles.card}>
          <View style={resStyles.cardHeaderRow}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Feather name="check-square" size={16} color="#2563EB" />
              <Text style={resStyles.cardHeaderTitle}>Bảng theo dõi & Phân công nhiệm vụ</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={resStyles.taskProgress}>
                Hoàn thành {completedTasksCount}/{tasks.length}
              </Text>

              {tasks.length > 0 && (
                <Pressable
                  onPress={async () => {
                    const header = `PHIẾU GIAO VIỆC & KẾT LUẬN CHỈ ĐẠO\n` +
                      `Cuộc họp: ${meetingTitle}\n` +
                      `Thời gian: ${docTime}\n` +
                      `Người chủ trì: ${docChair}\n` +
                      `──────────────────────────────────────────────────\n`;
                    const body = tasks.map((t, i) => {
                      const st = t.isDone ? "[x] ĐÃ HOÀN THÀNH" : "[ ] ĐANG THỰC HIỆN";
                      const title = `${i + 1}. ${st} - ${t.title}`;
                      const who = t.assignee_name ? `\n   Phụ trách: ${t.assignee_name}` : "\n   Phụ trách: Các đơn vị liên quan";
                      const due = t.due_date ? ` | Hạn: ${t.due_date}` : "";
                      const desc = t.description ? `\n   Nội dung: ${t.description}` : "";
                      return `${title}${who}${due}${desc}`;
                    }).join("\n\n");
                    const footer = `\n──────────────────────────────────────────────────\n` +
                      `Tổng số: ${tasks.length} nhiệm vụ (Đã hoàn tất: ${completedTasksCount}/${tasks.length})\n` +
                      `Trích xuất từ Hệ thống Trợ lý cuộc họp VietMeeting AI`;
                    const text = header + body + footer;

                    if (Platform.OS === "web") {
                      try {
                        await navigator.clipboard.writeText(text);
                      } catch {
                        Clipboard.setString(text);
                      }
                    } else {
                      Clipboard.setString(text);
                    }
                    setCopiedTaskSheet(true);
                    setTimeout(() => setCopiedTaskSheet(false), 2200);
                  }}
                  style={({ pressed }) => [
                    resStyles.copyBtn,
                    copiedTaskSheet && { backgroundColor: "rgba(16,185,129,0.15)", borderColor: "#10B981" },
                    pressed && resStyles.btnPressed,
                  ]}
                >
                  <Feather
                    name={copiedTaskSheet ? "check" : "share-2"}
                    size={13}
                    color={copiedTaskSheet ? "#10B981" : "#60A5FA"}
                  />
                  <Text style={[resStyles.copyBtnText, { color: copiedTaskSheet ? "#10B981" : "#60A5FA" }]}>
                    {copiedTaskSheet ? "Đã chép phiếu" : "Sao chép phiếu giao việc"}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>

          {tasks.length === 0 ? (
            <View style={resStyles.emptyTasksBox}>
              <Feather name="inbox" size={28} color="#64748B" />
              <Text style={resStyles.emptyTasksText}>Cuộc họp này không phát sinh nhiệm vụ phân công cụ thể.</Text>
            </View>
          ) : (
            <View style={{ gap: 8, marginTop: 12 }}>
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
                    {task.isDone ? <Feather name="check" size={12} color="#FFFFFF" /> : null}
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
                          <Feather name="user" size={11} color="#60A5FA" style={{ marginRight: 4 }} />
                          <Text style={resStyles.taskMetaText}>{task.assignee_name}</Text>
                        </View>
                      ) : null}
                      {task.due_date ? (
                        <View style={resStyles.taskMetaTag}>
                          <Feather name="calendar" size={11} color="#F59E0B" style={{ marginRight: 4 }} />
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
          TAB 3: BẢN GỠ BĂNG (TRANSCRIPT)
      ===================================================================== */}
      {activeTab === "transcript" && (
        <View style={{ gap: 12 }}>
          {/* Studio Audio Player */}
          {audioUrl ? <StudioAudioPlayer audioUrl={audioUrl} seekToRef={seekToRef} /> : null}

          {renderTypographyToolbar()}

          <View style={resStyles.card}>
            <View style={resStyles.cardHeaderRow}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Feather name="mic" size={16} color="#0284C7" />
                <Text style={resStyles.cardHeaderTitle}>Bản gỡ băng gốc (Gemini / Whisper STT)</Text>
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Pressable
                  onPress={() => setIsEditingTranscript(!isEditingTranscript)}
                  style={({ pressed }) => [
                    resStyles.copyBtn,
                    isEditingTranscript && { backgroundColor: "rgba(37,99,235,0.15)", borderColor: "#2563EB" },
                    pressed && resStyles.btnPressed,
                  ]}
                >
                  <Feather
                    name={isEditingTranscript ? "eye" : "edit-3"}
                    size={13}
                    color={isEditingTranscript ? "#2563EB" : "#94A3B8"}
                  />
                  <Text style={[resStyles.copyBtnText, isEditingTranscript && { color: "#2563EB" }]}>
                    {isEditingTranscript ? "Xem văn bản" : "Chỉnh sửa"}
                  </Text>
                </Pressable>

                {isEditingTranscript && (
                  <Pressable
                    onPress={handleSaveTranscriptToDB}
                    disabled={isSavingTranscript}
                    style={({ pressed }) => [resStyles.copyBtn, { backgroundColor: "rgba(16,185,129,0.12)" }, pressed && resStyles.btnPressed]}
                  >
                    {isSavingTranscript ? (
                      <ActivityIndicator size="small" color="#10B981" />
                    ) : (
                      <Feather
                        name={savedTranscriptToast ? "check" : "save"}
                        size={13}
                        color="#10B981"
                      />
                    )}
                    <Text style={[resStyles.copyBtnText, { color: "#10B981" }]}>
                      {savedTranscriptToast ? "Đã lưu" : "Lưu bản gỡ"}
                    </Text>
                  </Pressable>
                )}

                <Pressable
                  onPress={() => handleCopyText(transcriptContent)}
                  style={({ pressed }) => [resStyles.copyBtn, pressed && resStyles.btnPressed]}
                >
                  <Feather name={copied ? "check" : "copy"} size={13} color="#2563EB" />
                  <Text style={resStyles.copyBtnText}>{copied ? "Đã chép" : "Sao chép"}</Text>
                </Pressable>
              </View>
            </View>

            {/* Search Bar */}
            <View style={resStyles.searchBarRow}>
              <View style={resStyles.searchInputBox}>
                <Feather name="search" size={14} color="#64748B" style={{ marginRight: 8 }} />
                <TextInput
                  value={transcriptSearch}
                  onChangeText={setTranscriptSearch}
                  placeholder="Tìm kiếm từ khóa trong bản gỡ băng..."
                  placeholderTextColor="#64748B"
                  style={resStyles.searchInput}
                />
                {transcriptSearch.length > 0 ? (
                  <Pressable onPress={() => setTranscriptSearch("")} style={{ padding: 4 }}>
                    <Feather name="x" size={14} color="#94A3B8" />
                  </Pressable>
                ) : null}
              </View>

              {transcriptSearch.trim().length > 0 ? (
                <View style={resStyles.searchCountBadge}>
                  <Text style={resStyles.searchCountText}>
                    {transcriptMatchCount > 0
                      ? `Tìm thấy ${transcriptMatchCount} kết quả`
                      : "Không có kết quả"}
                  </Text>
                </View>
              ) : null}
            </View>

            {/* Văn bản bóc băng */}
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
                      const lines = fullText.split("\n");
                      return (
                        <View style={{ gap: 6 }}>
                          {lines.map((line, lIdx) => {
                            const trimmed = line.trim();
                            if (!trimmed) return null;
                            const match = trimmed.match(/^\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/);
                            if (match) {
                              const rawTs = match[0];
                              const h = match[1] ? parseInt(match[1], 10) : 0;
                              const m = parseInt(match[2], 10);
                              const sec = parseInt(match[3], 10);
                              const totalSec = h * 3600 + m * 60 + sec;
                              const rest = trimmed.slice(rawTs.length).trim();
                              return (
                                <View key={lIdx} style={{ flexDirection: "row", alignItems: "flex-start", flexWrap: "wrap", marginVertical: 2 }}>
                                  <Pressable
                                    onPress={() => seekToRef.current?.(totalSec)}
                                    style={({ pressed }) => [{
                                      flexDirection: "row",
                                      alignItems: "center",
                                      gap: 4,
                                      backgroundColor: pressed ? "rgba(37,99,235,0.25)" : "rgba(37,99,235,0.12)",
                                      borderColor: "rgba(37,99,235,0.3)",
                                      borderWidth: 1,
                                      borderRadius: 4,
                                      paddingHorizontal: 6,
                                      paddingVertical: 2,
                                      marginRight: 8,
                                      marginTop: 2,
                                    }]}
                                  >
                                    <Feather name="play-circle" size={11} color="#60A5FA" />
                                    <Text style={{ color: "#60A5FA", fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
                                      {rawTs}
                                    </Text>
                                  </Pressable>
                                  <Text
                                    style={[
                                      resStyles.transcriptText,
                                      {
                                        color: themeColors.text,
                                        fontFamily,
                                        fontSize,
                                        lineHeight: Math.round(fontSize * lineHeight * 1.3),
                                        flex: 1,
                                      },
                                    ]}
                                  >
                                    {rest}
                                  </Text>
                                </View>
                              );
                            }
                            return (
                              <Text
                                key={lIdx}
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
                                {line}
                              </Text>
                            );
                          })}
                        </View>
                      );
                    }

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
                                    fontWeight: "700",
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

      {/* =====================================================================
          TAB 4: HỎI ĐÁP AI COPILOT (GROUNDED MEETING ASSISTANT - NOTEBOOKLM)
      ===================================================================== */}
      {activeTab === "copilot" && (
        <View style={{ gap: 14 }}>
          {/* Header Card */}
          <View style={copilotStyles.heroCard}>
            <View style={copilotStyles.heroHeader}>
              <View style={copilotStyles.heroIconBox}>
                <Feather name="message-square" size={16} color="#2563EB" />
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Text style={copilotStyles.heroTitle}>Trợ lý Hỏi đáp Cuộc họp (Meeting Copilot)</Text>
                  <View style={copilotStyles.groundedBadge}>
                    <Feather name="shield" size={10} color="#10B981" style={{ marginRight: 4 }} />
                    <Text style={copilotStyles.groundedBadgeText}>100% Grounded Context</Text>
                  </View>
                </View>
                <Text style={copilotStyles.heroSub}>
                  Giải đáp mọi thắc mắc bám sát nội dung biên bản, bản gỡ băng âm thanh và nhiệm vụ
                </Text>
              </View>
            </View>

            {/* Smart Prompt Chips */}
            <View style={copilotStyles.chipsSection}>
              <Text style={copilotStyles.chipsTitle}>GỢI Ý CÂU HỎI TRỌNG TÂM:</Text>
              <View style={copilotStyles.chipsRow}>
                {COPILOT_QUICK_PROMPTS.map((promptText, idx) => (
                  <Pressable
                    key={idx}
                    disabled={copilotLoading}
                    onPress={() => handleAskCopilot(promptText)}
                    style={({ pressed }) => [
                      copilotStyles.promptChip,
                      pressed && copilotStyles.btnPressed,
                    ]}
                  >
                    <Feather name="help-circle" size={12} color="#60A5FA" style={{ marginRight: 5 }} />
                    <Text style={copilotStyles.promptChipText}>{promptText}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Input Bar */}
            <View style={copilotStyles.inputRow}>
              <TextInput
                value={copilotQuestion}
                onChangeText={setCopilotQuestion}
                placeholder="Đặt câu hỏi về nội dung, nhân sự hoặc quyết định trong cuộc họp..."
                placeholderTextColor="#64748B"
                style={copilotStyles.questionInput}
                editable={!copilotLoading}
                onSubmitEditing={() => handleAskCopilot()}
              />
              <Pressable
                onPress={() => handleAskCopilot()}
                disabled={copilotLoading || !copilotQuestion.trim()}
                style={({ pressed }) => [
                  copilotStyles.askSubmitBtn,
                  (!copilotQuestion.trim() || copilotLoading) && { opacity: 0.5 },
                  pressed && copilotStyles.btnPressed,
                ]}
              >
                {copilotLoading ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <>
                    <Feather name="send" size={13} color="#FFFFFF" style={{ marginRight: 6 }} />
                    <Text style={copilotStyles.askSubmitText}>Hỏi AI</Text>
                  </>
                )}
              </Pressable>
            </View>
          </View>

          {/* Answer Card */}
          {copilotLoading ? (
            <View style={copilotStyles.loadingCard}>
              <ActivityIndicator size="small" color="#2563EB" />
              <Text style={copilotStyles.loadingText}>
                Trợ lý AI đang tra cứu biên bản và phân tích dữ liệu cuộc họp...
              </Text>
            </View>
          ) : copilotAnswer ? (
            <View style={copilotStyles.answerCard}>
              <View style={copilotStyles.answerHeader}>
                <View style={copilotStyles.engineBadge}>
                  <Feather
                    name={copilotEngine === "gemini" ? "cloud" : "cpu"}
                    size={12}
                    color={copilotEngine === "gemini" ? "#2563EB" : "#94A3B8"}
                    style={{ marginRight: 5 }}
                  />
                  <Text style={[copilotStyles.engineText, { color: copilotEngine === "gemini" ? "#3B82F6" : "#94A3B8" }]}>
                    {copilotEngine === "gemini" ? "Google Gemini Pro AI" : "Local AI Engine"}
                  </Text>
                </View>

                <Pressable
                  onPress={() => handleCopyCopilotAnswer(copilotAnswer)}
                  style={({ pressed }) => [
                    copilotStyles.copyBtn,
                    pressed && copilotStyles.btnPressed,
                  ]}
                >
                  <Feather
                    name={copilotCopied ? "check" : "copy"}
                    size={12}
                    color={copilotCopied ? "#10B981" : "#94A3B8"}
                    style={{ marginRight: 4 }}
                  />
                  <Text style={[copilotStyles.copyText, copilotCopied && { color: "#10B981" }]}>
                    {copilotCopied ? "Đã sao chép" : "Sao chép câu trả lời"}
                  </Text>
                </Pressable>
              </View>

              <ScrollView style={copilotStyles.answerScroll} nestedScrollEnabled>
                <Text style={copilotStyles.answerBody}>{copilotAnswer}</Text>
              </ScrollView>
            </View>
          ) : (
            <View style={copilotStyles.emptyCard}>
              <View style={copilotStyles.emptyIconBox}>
                <Feather name="compass" size={24} color="#64748B" />
              </View>
              <Text style={copilotStyles.emptyTitle}>Sẵn sàng giải đáp mọi câu hỏi</Text>
              <Text style={copilotStyles.emptySub}>
                Nhấp vào gợi ý phía trên hoặc nhập câu hỏi bất kỳ để tra cứu nhanh thông tin từ cuộc họp này.
              </Text>
            </View>
          )}
        </View>
      )}

    </Animated.View>
  );
}

// ===========================================================================
// STYLES
// ===========================================================================
const s = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#0C0E12" },
  loadingContainer: { flex: 1, backgroundColor: "#0C0E12", alignItems: "center", justifyContent: "center" },
  loadingText: { color: "#94A3B8", fontSize: 13, marginTop: 10 },
  mainContainer: { flex: 1, width: "100%", maxWidth: 1200, alignSelf: "center" },

  navBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#262932",
    backgroundColor: "#111318",
  },
  navLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  backButton: {
    width: 34,
    height: 34,
    borderRadius: 6,
    backgroundColor: "#161920",
    borderWidth: 1,
    borderColor: "#262932",
    alignItems: "center",
    justifyContent: "center",
  },
  navTitleBox: { flex: 1 },
  navTitle: { color: "#F8FAFC", fontSize: 16, fontWeight: "700" },
  idBadge: {
    backgroundColor: "rgba(37, 99, 235, 0.12)",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(37, 99, 235, 0.25)",
  },
  idBadgeText: { color: "#60A5FA", fontSize: 10, fontWeight: "600", fontVariant: ["tabular-nums"] },
  navSubtitle: { color: "#64748B", fontSize: 11, marginTop: 2 },
  navRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#161920",
    borderWidth: 1,
    borderColor: "#262932",
  },
  statusPillRec: { backgroundColor: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.3)" },
  statusPillProc: { backgroundColor: "rgba(245, 158, 11, 0.1)", borderColor: "rgba(245, 158, 11, 0.3)" },
  statusPillDone: { backgroundColor: "rgba(16, 185, 129, 0.1)", borderColor: "rgba(16, 185, 129, 0.3)" },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#64748B" },
  statusPillText: { color: "#CBD5E1", fontSize: 11, fontWeight: "500" },

  scrollContent: { padding: 18, paddingBottom: 50 },
  grid: { flexDirection: Platform.OS === "web" ? "row" : "column", alignItems: "flex-start", gap: 18 },
  leftCol: { width: Platform.OS === "web" ? 360 : "100%", flexShrink: 0 },
  rightCol: { flex: 1, minWidth: 0, width: "100%" },

  /* Sony / Zoom Recorder Card */
  recorderCard: {
    backgroundColor: "#161920",
    borderRadius: 10,
    padding: 20,
    borderWidth: 1,
    borderColor: "#262932",
    alignItems: "center",
  },
  recorderHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#262932",
    marginBottom: 16,
  },
  recorderBrand: { flexDirection: "row", alignItems: "center", gap: 6 },
  recorderBrandText: { color: "#64748B", fontSize: 10, fontWeight: "700", letterSpacing: 0.8 },
  ledRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  ledIndicator: { width: 7, height: 7, borderRadius: 4 },
  ledText: { color: "#94A3B8", fontSize: 10, fontWeight: "700" },

  timerDisplay: {
    width: "100%",
    backgroundColor: "#0C0E12",
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#262932",
    marginBottom: 20,
  },
  timerText: {
    color: "#64748B",
    fontSize: 44,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.5,
  },
  timerActive: { color: "#F8FAFC" },
  timerSubtext: { color: "#475569", fontSize: 10, fontWeight: "600", letterSpacing: 0.5, marginTop: 4 },

  micWrap: { alignItems: "center", justifyContent: "center", marginBottom: 20, position: "relative" },
  micPulse: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 1.5,
    borderColor: "rgba(239, 68, 68, 0.3)",
    backgroundColor: "rgba(239, 68, 68, 0.06)",
  },
  micBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#2563EB",
    alignItems: "center",
    justifyContent: "center",
  },
  micBtnActive: { backgroundColor: "#EF4444" },

  recActionBtn: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 11,
    borderRadius: 8,
    marginBottom: 14,
  },
  recActionStart: { backgroundColor: "#2563EB" },
  recActionStop: { backgroundColor: "#EF4444" },
  recActionText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },

  dividerRow: { flexDirection: "row", alignItems: "center", width: "100%", marginBottom: 14 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#262932" },
  dividerText: { color: "#64748B", fontSize: 10, fontWeight: "600", paddingHorizontal: 10, letterSpacing: 0.5 },

  uploadBtn: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#111318",
    borderWidth: 1,
    borderColor: "#262932",
    marginBottom: 12,
  },
  uploadIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: "rgba(37, 99, 235, 0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  uploadTitle: { color: "#F8FAFC", fontSize: 12, fontWeight: "600" },
  uploadSub: { color: "#64748B", fontSize: 10, marginTop: 2 },
  selectedFileBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    width: "100%",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "rgba(37, 99, 235, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(37, 99, 235, 0.2)",
    marginBottom: 12,
  },
  selectedFileName: { flex: 1, color: "#60A5FA", fontSize: 11, fontWeight: "500" },
  selectedFileSize: { color: "#64748B", fontSize: 10 },

  specBox: { width: "100%", gap: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: "#262932" },
  specItem: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  specItemText: { color: "#94A3B8", fontSize: 11 },

  /* Idle Card */
  idleCard: {
    backgroundColor: "#161920",
    borderRadius: 10,
    padding: 28,
    borderWidth: 1,
    borderColor: "#262932",
    alignItems: "center",
  },
  idleIconBox: {
    width: 56,
    height: 56,
    borderRadius: 10,
    backgroundColor: "rgba(37, 99, 235, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(37, 99, 235, 0.25)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  idleTitle: { color: "#F8FAFC", fontSize: 17, fontWeight: "700", marginBottom: 6 },
  idleSub: { color: "#94A3B8", fontSize: 13, textAlign: "center", lineHeight: 20, maxWidth: 480, marginBottom: 24 },
  capList: { width: "100%", gap: 10 },
  capItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#111318",
    borderWidth: 1,
    borderColor: "#262932",
  },
  capBullet: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    alignItems: "center",
    justifyContent: "center",
  },
  capHead: { color: "#F8FAFC", fontSize: 13, fontWeight: "600", marginBottom: 2 },
  capBody: { color: "#94A3B8", fontSize: 11, lineHeight: 16 },

  recFeedbackCard: {
    backgroundColor: "#161920",
    borderRadius: 10,
    padding: 32,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.2)",
    alignItems: "center",
  },
  waveContainer: { flexDirection: "row", alignItems: "center", justifyContent: "center", height: 36, marginBottom: 16 },
  recFeedTitle: { color: "#F8FAFC", fontSize: 16, fontWeight: "700", marginBottom: 4 },
  recFeedSub: { color: "#94A3B8", fontSize: 12, textAlign: "center", lineHeight: 18, maxWidth: 400 },

  errorCard: {
    backgroundColor: "#161920",
    borderRadius: 10,
    padding: 28,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
    alignItems: "center",
  },
  errorIconBox: {
    width: 52,
    height: 52,
    borderRadius: 10,
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  errorTitle: { color: "#EF4444", fontSize: 16, fontWeight: "700", marginBottom: 4 },
  errorMsg: { color: "#F8FAFC", fontSize: 13, fontWeight: "500", textAlign: "center", marginBottom: 4 },
  errorDtl: { color: "#94A3B8", fontSize: 11, textAlign: "center", lineHeight: 16, marginBottom: 16 },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#2563EB",
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
  },
  retryBtnText: { color: "#FFFFFF", fontWeight: "600", fontSize: 13 },

  btnPressed: { opacity: 0.8 },
});

/* Technical Stepper Styles */
const procStyles = StyleSheet.create({
  container: {
    backgroundColor: "#161920",
    borderRadius: 10,
    padding: 22,
    borderWidth: 1,
    borderColor: "#262932",
  },
  metricRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  headerLeft: { flex: 1 },
  title: { color: "#F8FAFC", fontSize: 15, fontWeight: "700" },
  detail: { color: "#94A3B8", fontSize: 12, marginTop: 2 },
  percentText: {
    color: "#2563EB",
    fontSize: 24,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  progressBarBg: {
    width: "100%",
    height: 4,
    borderRadius: 2,
    backgroundColor: "#262932",
    marginBottom: 16,
    overflow: "hidden",
  },
  progressBarFill: { height: 4, borderRadius: 2, backgroundColor: "#2563EB" },
  stepList: { width: "100%", gap: 8, marginBottom: 14 },
  stepItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#111318",
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: "#262932",
  },
  stepItemActive: { borderColor: "#2563EB", backgroundColor: "rgba(37, 99, 235, 0.04)" },
  stepCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#1F232D",
    alignItems: "center",
    justifyContent: "center",
  },
  stepCircleActive: { backgroundColor: "rgba(37, 99, 235, 0.15)", borderWidth: 1, borderColor: "#2563EB" },
  stepCircleDone: { backgroundColor: "#10B981", borderColor: "#10B981" },
  stepNum: { color: "#64748B", fontSize: 11, fontWeight: "600" },
  stepTitle: { color: "#F8FAFC", fontSize: 12, fontWeight: "600" },
  stepSub: { color: "#64748B", fontSize: 10, marginTop: 1 },
  liveTranscriptBox: {
    width: "100%",
    backgroundColor: "#111318",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#262932",
    overflow: "hidden",
  },
  liveTranscriptHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#262932",
  },
  liveTranscriptTitle: { color: "#94A3B8", fontSize: 11, fontWeight: "600", flex: 1 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#10B981" },
  liveTranscriptScroll: { maxHeight: 180, padding: 12 },
  liveTranscriptText: { color: "#CBD5E1", fontSize: 11, lineHeight: 18, fontFamily: Platform.OS === "web" ? "monospace" : undefined },
});

/* Result Dashboard & Ribbon Styles */
const resStyles = StyleSheet.create({
  topBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#161920",
    borderRadius: 8,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.25)",
    marginBottom: 12,
    flexWrap: "wrap",
    gap: 10,
  },
  topBannerLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  successCircle: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: "rgba(16, 185, 129, 0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  topBannerTitle: { color: "#F8FAFC", fontSize: 14, fontWeight: "700" },
  topBannerSub: { color: "#94A3B8", fontSize: 11, marginTop: 1 },
  newRecBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(37, 99, 235, 0.1)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(37, 99, 235, 0.25)",
  },
  newRecBtnText: { color: "#60A5FA", fontSize: 11, fontWeight: "600" },

  tabsRow: { flexDirection: "row", gap: 6, marginBottom: 12, flexWrap: "wrap" },
  tabBtn: {
    flex: 1,
    minWidth: 120,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "#161920",
    borderWidth: 1,
    borderColor: "#262932",
  },
  tabBtnActive: { backgroundColor: "rgba(37, 99, 235, 0.12)", borderColor: "#2563EB" },
  tabText: { color: "#94A3B8", fontSize: 12, fontWeight: "500" },
  tabTextActive: { color: "#60A5FA", fontWeight: "600" },

  /* AI Style Switcher */
  aiStudioCard: {
    backgroundColor: "#161920",
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: "#262932",
    gap: 10,
  },
  aiStudioHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 6,
  },
  aiStudioIconBox: {
    width: 24,
    height: 24,
    borderRadius: 4,
    backgroundColor: "rgba(37, 99, 235, 0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  aiStudioTitle: { color: "#F8FAFC", fontSize: 13, fontWeight: "600" },
  aiStudioSub: { color: "#94A3B8", fontSize: 11, marginTop: 1 },
  aiLoadingBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(37, 99, 235, 0.1)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  aiLoadingText: { color: "#60A5FA", fontSize: 11, fontWeight: "600" },
  aiPresetsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  aiPresetBtn: {
    flex: 1,
    minWidth: 120,
    backgroundColor: "#111318",
    borderRadius: 6,
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: "#262932",
  },
  aiPresetBtnActive: {
    backgroundColor: "rgba(37, 99, 235, 0.12)",
    borderColor: "#2563EB",
  },
  aiPresetLabel: { color: "#F8FAFC", fontSize: 11, fontWeight: "600" },
  aiPresetDesc: { color: "#64748B", fontSize: 9, marginTop: 2 },
  aiPromptBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#111318",
    borderRadius: 6,
    padding: 4,
    borderWidth: 1,
    borderColor: "#262932",
  },
  aiPromptInput: {
    flex: 1,
    color: "#F8FAFC",
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  aiPromptSubmitBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#2563EB",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
  },
  aiPromptSubmitText: { color: "#FFFFFF", fontSize: 11, fontWeight: "600" },

  /* Ribbon Toolbar */
  ribbonToolbar: {
    backgroundColor: "#161920",
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: "#262932",
    gap: 8,
  },
  ribbonRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
  },
  ribbonGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  ribbonLabel: { color: "#64748B", fontSize: 11, fontWeight: "600" },
  fontPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: "#111318",
    borderWidth: 1,
    borderColor: "#262932",
  },
  fontPillActive: {
    backgroundColor: "#2563EB",
    borderColor: "#2563EB",
  },
  fontPillText: { color: "#94A3B8", fontSize: 11, fontWeight: "500" },
  fontPillTextActive: { color: "#FFFFFF", fontWeight: "600" },
  themePill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: "#111318",
    borderWidth: 1,
    borderColor: "#262932",
  },
  themePillActive: {
    backgroundColor: "rgba(37, 99, 235, 0.12)",
    borderColor: "#2563EB",
  },
  themePillText: { color: "#94A3B8", fontSize: 11, fontWeight: "500" },
  themePillTextActive: { color: "#60A5FA", fontWeight: "600" },

  sizeStepperBtn: {
    width: 24,
    height: 24,
    borderRadius: 4,
    backgroundColor: "#111318",
    borderWidth: 1,
    borderColor: "#262932",
    alignItems: "center",
    justifyContent: "center",
  },
  sizeStepperText: { color: "#CBD5E1", fontSize: 12, fontWeight: "600" },
  sizePill: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "#111318",
    borderWidth: 1,
    borderColor: "#262932",
  },
  sizePillActive: { backgroundColor: "#2563EB", borderColor: "#2563EB" },
  sizePillText: { color: "#94A3B8", fontSize: 10, fontWeight: "500", fontVariant: ["tabular-nums"] },
  sizePillTextActive: { color: "#FFFFFF", fontWeight: "600" },

  spacingPill: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "#111318",
    borderWidth: 1,
    borderColor: "#262932",
  },
  spacingPillActive: { backgroundColor: "rgba(37, 99, 235, 0.12)", borderColor: "#2563EB" },
  spacingPillText: { color: "#94A3B8", fontSize: 10, fontWeight: "500" },
  spacingPillTextActive: { color: "#60A5FA", fontWeight: "600" },

  alignBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "#111318",
    borderWidth: 1,
    borderColor: "#262932",
  },
  alignBtnActive: { backgroundColor: "rgba(37, 99, 235, 0.12)", borderColor: "#2563EB" },
  alignBtnText: { color: "#94A3B8", fontSize: 10, fontWeight: "500" },

  /* Action Toolbar */
  actionToolbarCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#161920",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#262932",
    flexWrap: "wrap",
    gap: 8,
  },
  actionToolbarLeft: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  actionToolbarRight: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },

  wordDownloadBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#2563EB",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
  },
  wordDownloadBtnText: { color: "#FFFFFF", fontSize: 12, fontWeight: "600" },

  toolBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#111318",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#262932",
  },
  toolBtnActive: {
    backgroundColor: "rgba(37, 99, 235, 0.12)",
    borderColor: "#2563EB",
  },
  toolBtnText: { color: "#CBD5E1", fontSize: 11, fontWeight: "500" },

  /* Quick Format */
  quickFormatCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#111318",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#262932",
    flexWrap: "wrap",
    gap: 6,
  },
  quickFormatLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexWrap: "wrap",
  },
  quickFormatLabel: { color: "#60A5FA", fontSize: 11, fontWeight: "600", marginRight: 2 },
  qfBtn: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "#161920",
    borderWidth: 1,
    borderColor: "#262932",
  },
  qfBtnText: { color: "#F8FAFC", fontSize: 11 },
  undoResetBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "rgba(239, 68, 68, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.25)",
  },
  undoResetText: { color: "#EF4444", fontSize: 11, fontWeight: "600" },

  /* A4 Paper Sheet */
  paperSheet: {
    borderRadius: 6,
    padding: Platform.OS === "web" ? 36 : 18,
    borderWidth: 1,
    maxWidth: 820,
    width: "100%",
    alignSelf: "center",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 3,
  },
  paperHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 1,
    paddingBottom: 12,
    marginBottom: 10,
  },
  paperHeaderLeft: { flex: 1, alignItems: "center" },
  paperOrgName: { fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  paperDocNo: { fontSize: 10, marginTop: 2 },
  paperHeaderRight: { flex: 1.2, alignItems: "center" },
  paperNationName: { fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  paperMotto: { fontSize: 12, fontWeight: "600", marginTop: 2 },
  paperMottoLine: { fontSize: 10, letterSpacing: -1, marginTop: -2 },

  paperDateRow: { alignItems: "flex-end", marginBottom: 14 },
  paperDateText: { fontSize: 11, fontStyle: "italic" },
  paperDateLabel: { fontSize: 11, fontStyle: "italic" },

  paperTitleBox: { alignItems: "center", marginBottom: 18 },
  paperMainTitle: { fontSize: 17, fontWeight: "700", letterSpacing: 0.5 },
  paperSubTitle: { fontSize: 12, fontWeight: "600", fontStyle: "italic", marginTop: 3 },
  paperSubTitleInput: {
    textAlign: "center",
    fontWeight: "600",
    fontStyle: "italic",
    fontSize: 12,
    minWidth: 240,
    marginTop: 3,
  },

  docSection: { marginBottom: 18 },
  docSectionHead: {
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    borderBottomWidth: 1,
    paddingBottom: 3,
    marginBottom: 8,
  },
  infoRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 5, flexWrap: "wrap" },
  infoLabel: { width: 170, fontSize: 12, fontWeight: "600" },
  infoVal: { flex: 1, lineHeight: 18 },
  infoInput: {
    flex: 1,
    fontSize: 12,
    borderWidth: 1,
    borderColor: "#94A3B8",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  inlineInput: {
    borderWidth: 1,
    borderColor: "#94A3B8",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 11,
  },

  editorBox: { marginTop: 6 },
  editorHint: { fontSize: 11, fontStyle: "italic", marginBottom: 6 },
  editorInput: {
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    minHeight: 260,
  },

  minutesRenderBox: { paddingHorizontal: 2 },
  paperSubHead: { fontWeight: "700", marginTop: 10, marginBottom: 3 },
  paperBulletRow: { flexDirection: "row", alignItems: "flex-start", marginLeft: 14, marginBottom: 3 },
  paperBulletDot: { fontSize: 13, marginRight: 6, lineHeight: 18 },
  paperBulletText: { flex: 1 },
  paperNormalText: { marginBottom: 6, paddingLeft: 6 },

  tableWrapper: {
    borderWidth: 1,
    borderRadius: 4,
    overflow: "hidden",
    marginTop: 4,
  },
  tableHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
  },
  thCell: {
    padding: 6,
    fontSize: 11,
    fontWeight: "700",
    borderRightWidth: 1,
  },
  tableDataRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    alignItems: "center",
  },
  tdCell: {
    padding: 6,
    fontSize: 11,
    borderRightWidth: 1,
  },
  taskCellTitle: { fontSize: 11, fontWeight: "600" },
  taskCellDesc: { fontSize: 10, fontStyle: "italic", marginTop: 1 },
  tableEmptyRow: { padding: 14, alignItems: "center" },
  tableEmptyText: { fontSize: 11, fontStyle: "italic" },

  sigContainer: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 28,
    paddingTop: 14,
    borderTopWidth: 1,
  },
  sigCol: { alignItems: "center", flex: 1 },
  sigRole: { fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  sigNote: { fontSize: 10, fontStyle: "italic", marginTop: 1 },
  sigSpace: { height: 50 },
  sigSigned: { color: "#10B981", fontSize: 10, fontStyle: "italic" },
  sigName: { fontSize: 12, fontWeight: "600", marginTop: 3 },

  /* Card for Tab 2 & 3 */
  card: {
    backgroundColor: "#161920",
    borderRadius: 10,
    padding: 16,
    borderWidth: 1,
    borderColor: "#262932",
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#262932",
    flexWrap: "wrap",
    gap: 6,
  },
  cardHeaderTitle: { color: "#F8FAFC", fontSize: 14, fontWeight: "600" },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#111318",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#262932",
  },
  copyBtnText: { color: "#94A3B8", fontSize: 11, fontWeight: "500" },

  searchBarRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 10,
    marginBottom: 4,
    flexWrap: "wrap",
    gap: 6,
  },
  searchInputBox: {
    flex: 1,
    minWidth: 240,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#111318",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#262932",
  },
  searchInput: { flex: 1, color: "#F8FAFC", fontSize: 12, padding: 0 },
  searchCountBadge: {
    backgroundColor: "rgba(254, 240, 138, 0.12)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(254, 240, 138, 0.25)",
  },
  searchCountText: { color: "#FEF08A", fontSize: 11, fontWeight: "600" },

  textBox: {
    marginTop: 10,
    padding: 14,
    borderRadius: 8,
    borderWidth: 1,
  },
  transcriptText: { fontSize: 12, lineHeight: 20 },
  transcriptInput: { minHeight: 260, padding: 0 },

  taskProgress: { color: "#10B981", fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] },
  emptyTasksBox: { alignItems: "center", justifyContent: "center", paddingVertical: 32 },
  emptyTasksText: { color: "#64748B", fontSize: 12, marginTop: 8, textAlign: "center" },
  taskItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#111318",
    borderWidth: 1,
    borderColor: "#262932",
  },
  taskItemDone: { backgroundColor: "rgba(16, 185, 129, 0.04)", borderColor: "rgba(16, 185, 129, 0.2)" },
  taskCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: "#475569",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  taskCheckboxDone: { backgroundColor: "#10B981", borderColor: "#10B981" },
  taskTitle: { color: "#F8FAFC", fontSize: 13, fontWeight: "600", lineHeight: 18 },
  taskTitleDone: { color: "#64748B", textDecorationLine: "line-through" },
  taskDesc: { color: "#94A3B8", fontSize: 11, lineHeight: 16, marginTop: 3 },
  taskMetaRow: { flexDirection: "row", gap: 6, marginTop: 6, flexWrap: "wrap" },
  taskMetaTag: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  taskMetaText: { color: "#CBD5E1", fontSize: 10, fontWeight: "500" },

  btnPressed: { opacity: 0.8 },
});

// ===========================================================================
// STYLES: MEETING COPILOT (NOTEBOOKLM PATTERN)
// ===========================================================================
const copilotStyles = StyleSheet.create({
  heroCard: {
    backgroundColor: "#161920",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#262932",
    padding: 16,
    gap: 14,
  },
  heroHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  heroIconBox: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: "rgba(37, 99, 235, 0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#F8FAFC",
  },
  heroSub: {
    fontSize: 11,
    color: "#94A3B8",
    marginTop: 2,
  },
  groundedBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(16, 185, 129, 0.1)",
    borderColor: "rgba(16, 185, 129, 0.25)",
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  groundedBadgeText: {
    fontSize: 10,
    color: "#10B981",
    fontWeight: "600",
  },
  chipsSection: {
    gap: 6,
  },
  chipsTitle: {
    fontSize: 10,
    color: "#64748B",
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  chipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  promptChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1A1D26",
    borderColor: "#262932",
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  promptChipText: {
    fontSize: 11,
    color: "#CBD5E1",
  },
  inputRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  questionInput: {
    flex: 1,
    backgroundColor: "#111318",
    borderWidth: 1,
    borderColor: "#262932",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: "#F8FAFC",
    fontSize: 13,
  },
  askSubmitBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#2563EB",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  askSubmitText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#FFFFFF",
  },
  btnPressed: {
    opacity: 0.8,
  },
  loadingCard: {
    padding: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#161920",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#262932",
    gap: 12,
  },
  loadingText: {
    fontSize: 12,
    color: "#94A3B8",
  },
  answerCard: {
    backgroundColor: "#161920",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#262932",
    padding: 16,
    gap: 12,
  },
  answerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#262932",
    paddingBottom: 10,
  },
  engineBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(37, 99, 235, 0.08)",
    borderColor: "rgba(37, 99, 235, 0.2)",
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  engineText: {
    fontSize: 11,
    fontWeight: "600",
  },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1A1D26",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "#262932",
  },
  copyText: {
    fontSize: 11,
    color: "#94A3B8",
  },
  answerScroll: {
    maxHeight: 460,
  },
  answerBody: {
    fontSize: 13,
    color: "#E2E8F0",
    lineHeight: 22,
  },
  emptyCard: {
    padding: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#161920",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#262932",
    gap: 10,
  },
  emptyIconBox: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#1A1D26",
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#F8FAFC",
  },
  emptySub: {
    fontSize: 12,
    color: "#94A3B8",
    textAlign: "center",
    maxWidth: 440,
  },
});
