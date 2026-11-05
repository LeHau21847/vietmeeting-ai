/**
 * src/components/AIConfigModal.tsx
 *
 * Modal cấu hình Google Gemini API Key & AI Engine Switcher (Hybrid AI).
 * Tích hợp huy hiệu trạng thái AI Engine trên Header.
 * Thiết kế theo chuẩn Human-Crafted UI: Zero-Emoji, Swiss/Linear Neutral Palette.
 */

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Clipboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import axios from "axios";

import { API_ENDPOINTS, API_TIMEOUT_SHORT_MS } from "@/constants/api";
import type { AIConfigData } from "@/types/meeting";

interface AIConfigModalProps {
  visible: boolean;
  onClose: () => void;
  onConfigUpdated?: (config: AIConfigData) => void;
}

export function AIConfigModal({
  visible,
  onClose,
  onConfigUpdated,
}: AIConfigModalProps): React.JSX.Element {
  const [config, setConfig] = useState<AIConfigData | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [preferredEngine, setPreferredEngine] = useState<"gemini" | "local">("gemini");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (visible) {
      fetchConfig();
      setSaveSuccess(false);
      setErrorMsg("");
    }
  }, [visible]);

  const fetchConfig = async () => {
    setIsLoading(true);
    try {
      const res = await axios.get<AIConfigData>(API_ENDPOINTS.aiConfig, {
        timeout: API_TIMEOUT_SHORT_MS,
      });
      setConfig(res.data);
      setPreferredEngine(res.data.preferred_engine);
    } catch {
      setErrorMsg("Không thể kết nối đến máy chủ để kiểm tra cấu hình AI.");
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasteClipboard = async () => {
    try {
      if (Platform.OS === "web") {
        const text = await navigator.clipboard.readText();
        if (text) setApiKeyInput(text.trim());
      } else {
        const text = await Clipboard.getString();
        if (text) setApiKeyInput(text.trim());
      }
    } catch {
      // ignore
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setErrorMsg("");
    setSaveSuccess(false);

    try {
      const payload: { gemini_api_key?: string; preferred_engine: "gemini" | "local" } = {
        preferred_engine: preferredEngine,
      };

      if (apiKeyInput.trim()) {
        payload.gemini_api_key = apiKeyInput.trim();
      }

      const res = await axios.post<AIConfigData>(API_ENDPOINTS.aiConfig, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: API_TIMEOUT_SHORT_MS,
      });

      setConfig(res.data);
      setApiKeyInput("");
      setSaveSuccess(true);
      if (onConfigUpdated) {
        onConfigUpdated(res.data);
      }
      setTimeout(() => {
        setSaveSuccess(false);
        onClose();
      }, 1000);
    } catch (err: any) {
      setErrorMsg(err?.response?.data?.message || "Lỗi khi lưu cấu hình AI.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.modalCard}>
          {/* Header */}
          <View style={styles.headerRow}>
            <View style={styles.headerLeft}>
              <View style={styles.iconBox}>
                <Feather name="sliders" size={17} color="#2563EB" />
              </View>
              <View>
                <Text style={styles.title}>Cấu hình AI Engine</Text>
                <Text style={styles.subTitle}>Google Gemini Multimodal & Local Offline AI</Text>
              </View>
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
              <Feather name="x" size={18} color="#94A3B8" />
            </Pressable>
          </View>

          {isLoading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="small" color="#2563EB" />
              <Text style={styles.loadingText}>Đang đọc cấu hình hệ thống...</Text>
            </View>
          ) : (
            <View style={styles.body}>
              {/* Trạng thái hiện tại */}
              <View style={styles.statusBox}>
                <View style={styles.statusRow}>
                  <Text style={styles.statusLabel}>Engine đang hoạt động:</Text>
                  <View
                    style={[
                      styles.engineTag,
                      config?.active_engine === "gemini"
                        ? styles.engineTagGemini
                        : styles.engineTagLocal,
                    ]}
                  >
                    <Feather
                      name={config?.active_engine === "gemini" ? "cloud" : "cpu"}
                      size={12}
                      color={config?.active_engine === "gemini" ? "#2563EB" : "#0284C7"}
                      style={{ marginRight: 5 }}
                    />
                    <Text
                      style={[
                        styles.engineTagText,
                        config?.active_engine === "gemini"
                          ? { color: "#1D4ED8" }
                          : { color: "#0369A1" },
                      ]}
                    >
                      {config?.active_engine === "gemini"
                        ? "Google Gemini Pro AI (Đám mây)"
                        : "Local Offline AI (Nội bộ)"}
                    </Text>
                  </View>
                </View>

                {config?.has_gemini_key ? (
                  <View style={styles.keyRow}>
                    <Feather name="check-circle" size={13} color="#10B981" />
                    <Text style={styles.keyActiveText}>
                      Khóa API hợp lệ:{" "}
                      <Text style={{ fontWeight: "600", color: "#34D399" }}>
                        {config.gemini_api_key_masked}
                      </Text>
                    </Text>
                  </View>
                ) : (
                  <View style={styles.keyRow}>
                    <Feather name="alert-circle" size={13} color="#F59E0B" />
                    <Text style={styles.keyMissingText}>
                      Chưa thiết lập Gemini API Key. Hệ thống sử dụng Local AI.
                    </Text>
                  </View>
                )}
              </View>

              {/* Lựa chọn Engine ưu tiên */}
              <Text style={styles.sectionLabel}>CHẾ ĐỘ XỬ LÝ MỤC TIÊU</Text>
              <View style={styles.engineChoiceRow}>
                {/* Option Gemini */}
                <Pressable
                  onPress={() => setPreferredEngine("gemini")}
                  style={[
                    styles.choiceCard,
                    preferredEngine === "gemini" && styles.choiceCardActiveGemini,
                  ]}
                >
                  <View style={styles.choiceHeader}>
                    <View style={styles.choiceIconBadge}>
                      <Feather
                        name="cloud"
                        size={15}
                        color={preferredEngine === "gemini" ? "#2563EB" : "#64748B"}
                      />
                    </View>
                    <View
                      style={[
                        styles.radioDot,
                        preferredEngine === "gemini" && styles.radioDotActiveGemini,
                      ]}
                    />
                  </View>
                  <Text style={styles.choiceTitle}>Google Gemini Pro</Text>
                  <Text style={styles.choiceDesc}>
                    Chính xác cao, xử lý tệp âm thanh trực tiếp qua Multimodal Audio, tốc độ nhanh.
                  </Text>
                </Pressable>

                {/* Option Local */}
                <Pressable
                  onPress={() => setPreferredEngine("local")}
                  style={[
                    styles.choiceCard,
                    preferredEngine === "local" && styles.choiceCardActiveLocal,
                  ]}
                >
                  <View style={styles.choiceHeader}>
                    <View style={styles.choiceIconBadge}>
                      <Feather
                        name="cpu"
                        size={15}
                        color={preferredEngine === "local" ? "#0284C7" : "#64748B"}
                      />
                    </View>
                    <View
                      style={[
                        styles.radioDot,
                        preferredEngine === "local" && styles.radioDotActiveLocal,
                      ]}
                    />
                  </View>
                  <Text style={styles.choiceTitle}>Local Offline AI</Text>
                  <Text style={styles.choiceDesc}>
                    Bảo mật tuyệt đối, hoạt động nội bộ không cần Internet (Whisper + Ollama).
                  </Text>
                </Pressable>
              </View>

              {/* Nhập/Cập nhật API Key */}
              <View style={styles.inputSection}>
                <View style={styles.inputHeaderRow}>
                  <Text style={styles.sectionLabel}>GOOGLE GEMINI API KEY</Text>
                  <Pressable onPress={handlePasteClipboard} style={styles.pasteBtn}>
                    <Feather name="clipboard" size={12} color="#2563EB" />
                    <Text style={styles.pasteBtnText}>Dán từ bộ nhớ đệm</Text>
                  </Pressable>
                </View>

                <TextInput
                  value={apiKeyInput}
                  onChangeText={setApiKeyInput}
                  placeholder={
                    config?.has_gemini_key
                      ? "Nhập khóa mới để thay thế (để trống nếu giữ nguyên)"
                      : "Dán Google Gemini API Key tại đây..."
                  }
                  placeholderTextColor="#64748B"
                  style={styles.keyInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={false}
                />
                <Text style={styles.inputHint}>
                  Khóa API được lưu an toàn vào tệp môi trường .env trên máy chủ.
                </Text>
              </View>

              {/* Thông báo lỗi nếu có */}
              {errorMsg ? (
                <View style={styles.errBanner}>
                  <Feather name="alert-triangle" size={14} color="#EF4444" />
                  <Text style={styles.errBannerText}>{errorMsg}</Text>
                </View>
              ) : null}

              {/* Thông báo thành công */}
              {saveSuccess ? (
                <View style={styles.successBanner}>
                  <Feather name="check" size={14} color="#10B981" />
                  <Text style={styles.successBannerText}>Đã cập nhật cấu hình AI thành công.</Text>
                </View>
              ) : null}

              {/* Nút lưu */}
              <View style={styles.btnRow}>
                <Pressable onPress={onClose} style={styles.cancelBtn}>
                  <Text style={styles.cancelBtnText}>Đóng</Text>
                </Pressable>

                <Pressable
                  onPress={handleSave}
                  disabled={isSaving}
                  style={[styles.saveBtn, isSaving && { opacity: 0.7 }]}
                >
                  {isSaving ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <>
                      <Feather name="save" size={14} color="#FFFFFF" style={{ marginRight: 6 }} />
                      <Text style={styles.saveBtnText}>Lưu cấu hình</Text>
                    </>
                  )}
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

/**
 * Huy hiệu AI Engine hiển thị trên Header (bấm để mở Modal cấu hình).
 */
export function AIEngineBadge({
  onPress,
  currentConfig,
}: {
  onPress: () => void;
  currentConfig?: AIConfigData | null;
}): React.JSX.Element {
  const [internalConfig, setInternalConfig] = useState<AIConfigData | null>(null);

  useEffect(() => {
    if (currentConfig) {
      setInternalConfig(currentConfig);
      return;
    }
    let isMounted = true;
    axios
      .get<AIConfigData>(API_ENDPOINTS.aiConfig, { timeout: 4000 })
      .then((res) => {
        if (isMounted) setInternalConfig(res.data);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [currentConfig]);

  const activeConfig = currentConfig || internalConfig;
  const isGemini =
    !activeConfig ||
    activeConfig.active_engine === "gemini" ||
    activeConfig.preferred_engine === "gemini" ||
    (Boolean(activeConfig.has_gemini_key) && activeConfig.preferred_engine !== "local");

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        badgeStyles.badge,
        isGemini ? badgeStyles.geminiBadge : badgeStyles.localBadge,
        pressed && { opacity: 0.8 },
      ]}
    >
      <View
        style={[
          badgeStyles.statusDot,
          { backgroundColor: isGemini ? "#2563EB" : "#64748B" },
        ]}
      />
      <Feather
        name={isGemini ? "cloud" : "cpu"}
        size={12}
        color={isGemini ? "#2563EB" : "#94A3B8"}
      />
      <Text style={[badgeStyles.badgeText, isGemini ? badgeStyles.geminiText : badgeStyles.localText]}>
        {isGemini ? "Gemini Pro AI" : "Local AI"}
      </Text>
      <Feather name="chevron-down" size={11} color={isGemini ? "#2563EB" : "#64748B"} />
    </Pressable>
  );
}

const badgeStyles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  geminiBadge: {
    backgroundColor: "rgba(37, 99, 235, 0.1)",
    borderColor: "rgba(37, 99, 235, 0.28)",
  },
  localBadge: {
    backgroundColor: "rgba(100, 116, 139, 0.08)",
    borderColor: "rgba(100, 116, 139, 0.25)",
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "600",
  },
  geminiText: {
    color: "#3B82F6",
  },
  localText: {
    color: "#94A3B8",
  },
});

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(12, 14, 18, 0.8)",
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  modalCard: {
    width: "100%",
    maxWidth: 500,
    backgroundColor: "#161920",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#262932",
    overflow: "hidden",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#262932",
    backgroundColor: "#1A1D26",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  iconBox: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: "rgba(37, 99, 235, 0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
    color: "#F8FAFC",
  },
  subTitle: {
    fontSize: 11,
    color: "#94A3B8",
    marginTop: 1,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: "#1F232D",
    alignItems: "center",
    justifyContent: "center",
  },
  loadingBox: {
    padding: 36,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  loadingText: {
    color: "#94A3B8",
    fontSize: 13,
  },
  body: {
    padding: 18,
    gap: 14,
  },
  statusBox: {
    backgroundColor: "#111318",
    borderRadius: 8,
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: "#262932",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  statusLabel: {
    color: "#94A3B8",
    fontSize: 12,
    fontWeight: "500",
  },
  engineTag: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: "#1F232D",
  },
  engineTagGemini: {
    backgroundColor: "rgba(37, 99, 235, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(37, 99, 235, 0.25)",
  },
  engineTagLocal: {
    backgroundColor: "rgba(2, 132, 199, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(2, 132, 199, 0.25)",
  },
  engineTagText: {
    fontSize: 11,
    fontWeight: "600",
  },
  keyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.05)",
  },
  keyActiveText: {
    fontSize: 12,
    color: "#CBD5E1",
  },
  keyMissingText: {
    fontSize: 12,
    color: "#F59E0B",
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#64748B",
    letterSpacing: 0.6,
  },
  engineChoiceRow: {
    flexDirection: "row",
    gap: 10,
  },
  choiceCard: {
    flex: 1,
    backgroundColor: "#111318",
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: "#262932",
    gap: 6,
  },
  choiceCardActiveGemini: {
    borderColor: "#2563EB",
    backgroundColor: "rgba(37, 99, 235, 0.06)",
  },
  choiceCardActiveLocal: {
    borderColor: "#0284C7",
    backgroundColor: "rgba(2, 132, 199, 0.06)",
  },
  choiceHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  choiceIconBadge: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: "#1F232D",
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "#475569",
  },
  radioDotActiveGemini: {
    borderColor: "#2563EB",
    backgroundColor: "#2563EB",
  },
  radioDotActiveLocal: {
    borderColor: "#0284C7",
    backgroundColor: "#0284C7",
  },
  choiceTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#F1F5F9",
  },
  choiceDesc: {
    fontSize: 11,
    color: "#94A3B8",
    lineHeight: 16,
  },
  inputSection: {
    gap: 6,
  },
  inputHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pasteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "rgba(37, 99, 235, 0.1)",
  },
  pasteBtnText: {
    fontSize: 11,
    color: "#60A5FA",
    fontWeight: "500",
  },
  keyInput: {
    backgroundColor: "#111318",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#262932",
    color: "#F8FAFC",
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  inputHint: {
    fontSize: 11,
    color: "#64748B",
  },
  errBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(239, 68, 68, 0.08)",
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.25)",
  },
  errBannerText: {
    fontSize: 12,
    color: "#FCA5A5",
    flex: 1,
  },
  successBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(16, 185, 129, 0.08)",
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.25)",
  },
  successBannerText: {
    fontSize: 12,
    color: "#6EE7B7",
    flex: 1,
  },
  btnRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  cancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#1F232D",
    borderWidth: 1,
    borderColor: "#262932",
  },
  cancelBtnText: {
    color: "#94A3B8",
    fontSize: 13,
    fontWeight: "500",
  },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#2563EB",
  },
  saveBtnText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
  },
});
