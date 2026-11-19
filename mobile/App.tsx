/**
 * App.tsx – Root component của VietMeeting AI Mobile
 *
 * Navigation Stack:
 *   HomeScreen      ← Màn hình khởi đầu (danh sách cuộc họp)
 *   RecordingScreen ← Màn hình ghi âm (nhận meetingId + meetingTitle từ params)
 */

import "./global.css";
import React, { useEffect } from "react";
import { Platform } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import HomeScreen from "@/screens/HomeScreen";
import RecordingScreen from "@/screens/RecordingScreen";
import { VercelToastHost } from "@/components/VercelToast";
import type { RootStackParamList } from "@/types/meeting";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App(): React.JSX.Element {
  // Đăng ký Service Worker PWA cho phép F5 trình duyệt khi mất mạng (Offline Cache)
  useEffect(() => {
    if (
      Platform.OS === "web" &&
      typeof window !== "undefined" &&
      "serviceWorker" in navigator
    ) {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch(() => {
          // Bỏ qua nếu trình duyệt chặn SW ở môi trường dev
        });
    }
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor="#0C0E12" />
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName="Home"
          screenOptions={{
            headerShown: false,           // Header tuỳ chỉnh trong từng screen
            contentStyle: { backgroundColor: "#0C0E12" },
            animation: "slide_from_right",
          }}
        >
          <Stack.Screen name="Home" component={HomeScreen} />
          <Stack.Screen name="Recording" component={RecordingScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      <VercelToastHost />
    </SafeAreaProvider>
  );
}
