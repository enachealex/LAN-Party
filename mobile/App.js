import React from 'react';
import { Text, View, StyleSheet } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>LAN Party (Mobile)</Text>
      <Text>Use the mobile app to join servers and voice chats.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b0d12' },
  title: { fontSize: 20, fontWeight: '700', color: '#e6eef8', marginBottom: 8 }
});
