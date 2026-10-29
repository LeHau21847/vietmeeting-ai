/**
 * App.tsx – Root component của VietMeeting AI Mobile
 *
 * Navigation Stack:
 *   HomeScreen      ← Màn hình khởi đầu (danh sách cuộc họp)
 *   RecordingScreen ← Màn hình ghi âm (nhận meetingId + meetingTitle từ params)
 */

import "./global.css";
import React from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import HomeScreen from "@/screens/HomeScreen";
import RecordingScreen from "@/screens/RecordingScreen";
import type { RootStackParamList } from "@/types/meeting";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor="#0f0f1a" />
      <NavigationContainer>
        <Stack.Navigator
          initialRouteName="Home"
          screenOptions={{
            headerShown: false,           // Header tuỳ chỉnh trong từng screen
            contentStyle: { backgroundColor: "#0f0f1a" },
            animation: "slide_from_right",
          }}
        >
          <Stack.Screen name="Home" component={HomeScreen} />
          <Stack.Screen name="Recording" component={RecordingScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
