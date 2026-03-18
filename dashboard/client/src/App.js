import React, { Component } from 'react';
import { Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import DashboardPage from './pages/DashboardPage';

export default class App extends Component {
    render () {
        return (
            <Layout>
                <Route exact path='/' component={DashboardPage} />
            </Layout>
        );
    }
}
